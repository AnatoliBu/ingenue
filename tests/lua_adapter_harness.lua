local root = arg[1] or "."
local hooks = {}
local sent = {}
local enc_calls = {}
local key_calls = {}
local grid_keys = {}
local physical_led_calls = 0
local previous_events = 0

package.preload['core/mods'] = function()
  return {
    hook = {register = function(which, name, fn)
      hooks[which] = hooks[which] or {}
      hooks[which][name] = fn
    end}
  }
end

osc = {send = function(to, path, args)
  table.insert(sent, {to=to,path=path,args=args})
end}

local payloads = {
  ['{"n":2,"d":-3}'] = {n=2,d=-3},
  ['{"id":"cutoff","value":0.5}'] = {id='cutoff',value=0.5},
  ['{"id":"missing","value":0.5}'] = {id='missing',value=0.5},
  ['{"port":1,"x":4,"y":3,"z":1}'] = {port=1,x=4,y=3,z=1},
}
json = {decode = function(raw)
  if not payloads[raw] then error('unknown fixture JSON') end
  return payloads[raw]
end}
_json = json

params = {
  lookup_param = function(self,id) if id=='cutoff' then return {id=id} end return nil end,
  set = function(self,id,value) self.last={id=id,value=value} end,
}

_norns = {
  enc = function(n,d) table.insert(enc_calls,{n,d}) end,
  key = function(n,z) table.insert(key_calls,{n,z}) end,
  osc = {event = function() previous_events=previous_events+1 end},
}

grid = {vports={},update_devices=function() end}
for port=1,4 do
  grid.vports[port] = {
    device=nil,cols=0,rows=0,key=nil,
    led=function() physical_led_calls=physical_led_calls+1 end,
    all=function() end,
    refresh=function() end,
  }
end
grid.vports[1].key=function(x,y,z) table.insert(grid_keys,{x,y,z}) end

local chunk,err=loadfile(root..'/web/lib/mod.lua')
assert(chunk,err)
local api=chunk()
assert(api.version=='1')
assert(hooks.system_post_startup and hooks.system_post_startup['ingenue realtime adapter'])
hooks.system_post_startup['ingenue realtime adapter']()
assert(_norns.osc.event~=nil)
assert(grid.vports[1].cols==16 and grid.vports[1].rows==8)

_norns.osc.event('/other',{}, {'127.0.0.1',1})
assert(previous_events==1)

_norns.osc.event('/ingenue/command',{'w1','control','enc','{"n":2,"d":-3}',10112},{})
assert(#enc_calls==1 and enc_calls[1][1]==2 and enc_calls[1][2]==-3)
assert(sent[#sent].path=='/ingenue/ack' and sent[#sent].args[1]=='w1')

_norns.osc.event('/ingenue/command',{'w2','param','set','{"id":"cutoff","value":0.5}',10112},{})
assert(params.last.id=='cutoff' and params.last.value==0.5)
assert(sent[#sent].path=='/ingenue/ack')

_norns.osc.event('/ingenue/command',{'w3','param','set','{"id":"missing","value":0.5}',10112},{})
assert(sent[#sent].path=='/ingenue/reject' and sent[#sent].args[1]=='w3')

_norns.osc.event('/ingenue/command',{'w4','grid','key','{"port":1,"x":4,"y":3,"z":1}',10112},{})
assert(#grid_keys==1 and grid_keys[1][1]==4 and grid_keys[1][2]==3 and grid_keys[1][3]==1)
assert(sent[#sent].path=='/ingenue/ack')

grid.vports[1]:led(2,1,15,false)
grid.vports[1]:refresh()
assert(physical_led_calls==1)
local frame=sent[#sent]
assert(frame.path=='/ingenue/grid')
assert(frame.args[1]==1 and frame.args[2]==16 and frame.args[3]==8)
assert(#frame.args[4]==128 and frame.args[4]:sub(2,2)=='f')

print('lua adapter harness ok')
