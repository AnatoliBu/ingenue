import pathlib
import sys
import unittest
from types import SimpleNamespace

ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'web'))
from web.realtime_midi import MidiAppliedAdapter, parse_param_result  # noqa: E402
from web.realtime_server import RealtimeError  # noqa: E402

class Legacy:
    HERE='.'
    _CTL={}
    def osc_send(self,*args): self.sent=args

class MidiBridgeTests(unittest.TestCase):
    def test_parse_descriptor_preserves_non_finite_text(self):
        value=parse_param_result(['param','level',3,'control',0.5,'-6','-inf','0','Level','-6 dB','',1])
        self.assertEqual(value['normalized'],0.5)
        self.assertIsNone(value['min'])
        self.assertEqual(value['min_text'],'-inf')
    def test_prepare_normalized_and_delta_commands(self):
        adapter=MidiAppliedAdapter(Legacy(),7778,7779)
        prepared=adapter.prepare('wire-1',{'target':'param','action':'set_normalized','args':{'id':'cutoff','value':.7}})
        self.assertEqual(prepared.osc_args[-1],.7)
        delta=adapter.prepare('wire-2',{'target':'param','action':'delta','args':{'id':'cutoff','d':-1}})
        self.assertEqual(delta.osc_args[-1],-1)
    def test_invalid_normalized_value_rejected(self):
        adapter=MidiAppliedAdapter(Legacy(),7778,7779)
        with self.assertRaises(RealtimeError): adapter.prepare('x',{'target':'param','action':'set_normalized','args':{'id':'cutoff','value':2}})
    def test_lua_loader_and_adapter_contract(self):
        loader=(ROOT/'web/lib/mod.lua').read_text()
        lua=(ROOT/'web/lib/ingenue_midi.lua').read_text()
        self.assertIn("require 'ingenue_grid_mod'",loader)
        self.assertIn("require 'ingenue_midi'",loader)
        for needle in ['/ingenue/midi-command','set_normalized','params:delta','param:get_raw()']:
            self.assertIn(needle,lua)
        self.assertNotIn('loadstring',lua)

if __name__=='__main__': unittest.main()
