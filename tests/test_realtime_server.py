import ast
import json
import os
import struct
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'web'))

import web.realtime_secure as realtime_secure
from web.realtime_secure import OriginCheckedServer, origin_allowed
from web.realtime_server import (
    LegacyAdapter,
    Peer,
    RealtimeError,
    RealtimeHub,
    encode_frame,
    read_frame,
    websocket_accept,
)


class MemorySocket:
    def __init__(self, incoming=b""):
        self.incoming=bytearray(incoming);self.sent=bytearray();self.closed=False
    def recv(self,n):
        if not self.incoming:return b""
        out=bytes(self.incoming[:n]);del self.incoming[:n];return out
    def sendall(self,data):self.sent.extend(data)
    def shutdown(self,*_):pass
    def close(self):self.closed=True


def masked_frame(payload, opcode=1, mask=b"abcd"):
    payload=payload if isinstance(payload,bytes) else payload.encode()
    n=len(payload);assert n<126
    encoded=bytes(value^mask[i%4] for i,value in enumerate(payload))
    return bytes([0x80|opcode,0x80|n])+mask+encoded


def sent_messages(sock):
    data=bytes(sock.sent);out=[]
    while data:
        n=data[1]&0x7f;start=2
        if n==126:n=struct.unpack('>H',data[2:4])[0];start=4
        elif n==127:n=struct.unpack('>Q',data[2:10])[0];start=10
        out.append(json.loads(data[start:start+n]));data=data[start+n:]
    return out


class RealtimeServerTests(unittest.TestCase):
    def test_server_sources_parse_with_python_37_grammar(self):
        for relative in (
            'web/realtime_server.py','web/realtime_bridge.py','web/realtime_secure.py',
            'web/realtime_grid.py','web/ensure_mod_enabled.py','web/server.py'
        ):
            source=(ROOT/relative).read_text(encoding='utf-8')
            ast.parse(source,filename=relative,feature_version=(3,7))

    def test_rfc_websocket_accept(self):
        self.assertEqual(websocket_accept('dGhlIHNhbXBsZSBub25jZQ=='),'s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

    def test_masked_client_frame_round_trips(self):
        opcode,payload=read_frame(MemorySocket(masked_frame('hello')))
        self.assertEqual(opcode,1);self.assertEqual(payload,b'hello')
        self.assertTrue(encode_frame('hello').endswith(b'hello'))

    def test_unmasked_client_frame_is_rejected(self):
        with self.assertRaises(RealtimeError):read_frame(MemorySocket(encode_frame('bad')))

    def test_origin_allows_only_current_ingenue_http_origin(self):
        self.assertTrue(origin_allowed('http://norns.local:7777','norns.local:7778',7777))
        self.assertTrue(origin_allowed('http://192.168.1.20:7777','192.168.1.20:7778',7777))
        self.assertFalse(origin_allowed('http://evil.example','norns.local:7778',7777))
        self.assertFalse(origin_allowed(None,'norns.local:7778',7777))
        self.assertFalse(origin_allowed('null','norns.local:7778',7777))

    def test_origin_exact_allowlist_supports_reverse_proxy(self):
        self.assertTrue(origin_allowed('https://music.example','norns.local:7778',7777,{'https://music.example'}))
        self.assertFalse(origin_allowed('https://music.example.evil','norns.local:7778',7777,{'https://music.example'}))

    def test_origin_checked_server_preserves_realtime_hub(self):
        hub=object()
        server=OriginCheckedServer(('127.0.0.1',0),hub,7777,())
        try:
            self.assertIs(server.hub,hub)
        finally:
            server.server_close()

    def _serve_mode_events(self, strict_value):
        events=[]
        adapter=object();hub=object()

        class FakeBridge:
            def __init__(self, received_hub, host, port):
                self.received_hub=received_hub
                events.append(('bridge-init',received_hub,host,port))
            def start(self):events.append(('bridge-start',))
            def close(self):events.append(('bridge-close',))

        class FakeServer:
            def __init__(self, kind, address, received_hub, extra=()):
                self.kind=kind
                events.append(('server-init',kind,address,received_hub,extra))
            def __enter__(self):events.append(('server-enter',self.kind));return self
            def __exit__(self,*_):events.append(('server-exit',self.kind))
            def serve_forever(self):events.append(('serve',self.kind))

        def open_server(address, received_hub):
            return FakeServer('open',address,received_hub)

        def strict_server(address, received_hub, http_port, allowed):
            return FakeServer('strict',address,received_hub,(http_port,tuple(allowed)))

        replacements={
            'StateBridge':FakeBridge,
            'MidiAppliedAdapter':lambda *_args,**_kwargs:adapter,
            'MidiAppliedHub':lambda received_adapter:hub if received_adapter is adapter else None,
            'ThreadingRealtimeServer':open_server,
            'OriginCheckedServer':strict_server,
        }
        environment={
            'INGENUE_REALTIME_STRICT':strict_value,
            'INGENUE_STATE_PORT':'7779',
            'INGENUE_REALTIME_ORIGINS':'https://music.example',
        }
        with patch.multiple(realtime_secure,**replacements):
            with patch.dict(os.environ,environment,clear=True):
                realtime_secure.serve_realtime('127.0.0.1',7778,SimpleNamespace(PORT=7777))
        return events,hub

    def test_realtime_server_is_open_for_local_network_by_default(self):
        events,hub=self._serve_mode_events('')
        self.assertIn(('server-init','open',('127.0.0.1',7778),hub,()),events)
        self.assertIn(('serve','open'),events)
        self.assertIn(('bridge-close',),events)
        self.assertFalse(any(event[:2]==('server-init','strict') for event in events))

    def test_realtime_server_strict_origin_mode_is_opt_in(self):
        events,hub=self._serve_mode_events('1')
        self.assertIn(('server-init','strict',('127.0.0.1',7778),hub,(7777,('https://music.example',))),events)
        self.assertIn(('serve','strict'),events)
        self.assertIn(('bridge-close',),events)
        self.assertFalse(any(event[:2]==('server-init','open') for event in events))

    def make_hub(self, realtime_port=9000):
        calls=[]
        legacy=SimpleNamespace(PORT=7777,DUST='/dust',_CTL={'hits':0,'last':None,'ts':0},installed_sha=lambda:'abc',osc_send=lambda *args:calls.append(args))
        return RealtimeHub(LegacyAdapter(legacy,realtime_port=realtime_port,now=lambda:12.5)),calls

    def test_subscribe_returns_filtered_authoritative_snapshot(self):
        hub,_=self.make_hub();sock=MemorySocket();peer=Peer(sock);hub.register(peer)
        hub.handle(peer,{'v':1,'type':'subscribe','channels':['control']})
        message=sent_messages(sock)[0]
        self.assertEqual(message['type'],'snapshot');self.assertEqual(message['rev'],0);self.assertEqual(set(message['state']),{'control'})

    def test_snapshot_reports_actual_configured_realtime_port(self):
        hub,_=self.make_hub(realtime_port=9123);peer=Peer(MemorySocket())
        hub.handle(peer,{'v':1,'type':'subscribe','channels':['device']})
        self.assertEqual(sent_messages(peer.sock)[0]['state']['device']['realtime_port'],9123)

    def test_base_hub_control_command_acknowledges_and_broadcasts_delta(self):
        hub,calls=self.make_hub();sender=Peer(MemorySocket(),channels={'control'});observer=Peer(MemorySocket(),channels={'control'});hub.register(sender);hub.register(observer)
        hub.handle(sender,{'v':1,'type':'command','id':'cmd-1','command':{'target':'control','action':'enc','args':{'n':2,'d':-3}}})
        self.assertEqual(calls,[('/remote/enc','ii',2,-3)])
        sender_types=[m['type'] for m in sent_messages(sender.sock)]
        self.assertEqual(sender_types,['delta','ack'])
        self.assertEqual(sent_messages(observer.sock)[0]['rev'],1)

    def test_invalid_command_rejects_without_advancing_revision(self):
        hub,_=self.make_hub();peer=Peer(MemorySocket(),channels={'control'});hub.register(peer)
        hub.handle(peer,{'v':1,'type':'command','id':'bad','command':{'target':'control','action':'enc','args':{'n':99,'d':1}}})
        message=sent_messages(peer.sock)[0]
        self.assertEqual(message['type'],'reject');self.assertEqual(hub.revision,0)

    def test_ping_ack_does_not_create_state_revision(self):
        hub,_=self.make_hub();peer=Peer(MemorySocket());hub.register(peer)
        hub.handle(peer,{'v':1,'type':'command','id':'ping','command':{'target':'system','action':'ping'}})
        message=sent_messages(peer.sock)[0]
        self.assertEqual(message['type'],'ack');self.assertEqual(message['rev'],0)


if __name__=='__main__':unittest.main()
