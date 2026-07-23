-- Ingenue virtual monome Arc adapter.
-- Mirrors varibright rings to the browser while preserving physical Arc output.
local mods = require 'core/mods'
local dispatcher = require 'ingenue_midi'

local M = {
  state_port = 7779,
  virtual_port = 1,
  virtual_rings = 4,
  frames = {},
  originals = {},
  wrapped = false,
  virtual_device = nil,
  original_arc_update = nil,
}

local TAU = math.pi * 2

local function clamp(value, low, high)
  value = tonumber(value) or 0
  if value < low then return low end
  if value > high then return high end
  return value
end

local function strict_integer(value, label, low, high)
  if type(value) ~= 'number' or value ~= math.floor(value) then
    error(label .. ' must be an integer')
  end
  if value < low or value > high then
    error(label .. ' must be between ' .. low .. ' and ' .. high)
  end
  return value
end

local function read_state_port()
  local candidates = {
    _path.code .. 'ingenue/data/realtime-state-port',
    _path.code .. 'ingenue/web/data/realtime-state-port',
  }
  for _, path in ipairs(candidates) do
    local file = io.open(path, 'r')
    if file then
      local value = tonumber(file:read('*l'))
      file:close()
      if value and value > 0 and value < 65536 then
        M.state_port = value
        return
      end
    end
  end
end

local function send(path, args)
  local ok, err = pcall(osc.send, {'127.0.0.1', M.state_port}, path, args)
  if not ok then print('ingenue Arc send failed: ' .. tostring(err)) end
end

local function frame_for(port)
  local vp = arc and arc.vports and arc.vports[port]
  local rings = M.virtual_rings
  if vp and vp.device and tonumber(vp.device.rings) then
    local reported = math.floor(tonumber(vp.device.rings))
    if reported == 2 or reported == 4 then rings = reported end
  end
  local frame = M.frames[port]
  if frame == nil or frame.rings ~= rings then
    local previous = frame and frame.values or {}
    frame = {rings=rings, values={}, dirty=true, sequence=0, intensity=15}
    for i=1,rings*64 do frame.values[i] = previous[i] or 0 end
    M.frames[port] = frame
  end
  return frame
end

local function frame_index(frame, ring, led)
  if ring < 1 or ring > frame.rings then return nil end
  led = ((math.floor(led) - 1) % 64) + 1
  return (ring - 1) * 64 + led
end

local function set_led(port, ring, led, value, relative)
  local frame = frame_for(port)
  ring = math.floor(tonumber(ring) or 0)
  led = math.floor(tonumber(led) or 1)
  local index = frame_index(frame, ring, led)
  if not index then return end
  local numeric = tonumber(value) or 0
  local next_value
  if relative then
    next_value = clamp((frame.values[index] or 0) + numeric, 0, 15)
  else
    next_value = clamp(numeric, 0, 15)
  end
  next_value = math.floor(next_value)
  if frame.values[index] ~= next_value then
    frame.values[index] = next_value
    frame.dirty = true
  end
end

local function set_all(port, value, relative)
  local frame = frame_for(port)
  local numeric = tonumber(value) or 0
  for i=1,#frame.values do
    local next_value
    if relative then
      next_value = clamp((frame.values[i] or 0) + numeric, 0, 15)
    else
      next_value = clamp(numeric, 0, 15)
    end
    next_value = math.floor(next_value)
    if frame.values[i] ~= next_value then
      frame.values[i] = next_value
      frame.dirty = true
    end
  end
end

local function overlap(a, b, c, d)
  if a > b then
    return overlap(a, TAU, c, d) + overlap(0, b, c, d)
  elseif c > d then
    return overlap(a, b, c, TAU) + overlap(a, b, 0, d)
  end
  return math.max(0, math.min(b, d) - math.max(a, c))
end

local function overlap_segments(a, b, c, d)
  return overlap(a % TAU, b % TAU, c % TAU, d % TAU)
end

local function set_segment(port, ring, from, to, level, relative)
  local slice = TAU / 64
  from = tonumber(from) or 0
  to = tonumber(to) or 0
  level = clamp(level, 0, 15)
  for led=1,64 do
    local start_angle = slice * (led - 1)
    local end_angle = slice * led
    local amount = overlap_segments(from, to, start_angle, end_angle)
    local value = math.floor(amount / slice * level + 0.5)
    set_led(port, ring, led, value, relative)
  end
end

local function encode_frame(frame)
  local out = {}
  for i=1,#frame.values do
    out[i] = string.format('%x', math.floor(clamp(frame.values[i], 0, 15)))
  end
  return table.concat(out)
end

local function send_frame(port, force)
  local frame = frame_for(port)
  if not force and not frame.dirty then return end
  frame.sequence = frame.sequence + 1
  frame.dirty = false
  local vp = arc.vports[port]
  local virtual = vp and vp.device and vp.device._ingenue_virtual and 1 or 0
  send('/ingenue/arc/frame', {
    port, frame.rings, encode_frame(frame), frame.sequence,
    frame.intensity or 15, virtual
  })
end

local function make_virtual_device(port)
  return {
    id = -2000 - port,
    serial = 'browser-arc',
    name = 'ingenue virtual arc',
    port = port,
    rings = M.virtual_rings,
    _ingenue_virtual = true,
    led = function() end,
    all = function() end,
    refresh = function() end,
    segment = function() end,
    intensity = function() end,
  }
end

local function attach_virtual()
  if not arc or not arc.vports then return end
  local vp = arc.vports[M.virtual_port]
  if not vp then return end
  if vp.device == nil then
    if M.virtual_device == nil then
      M.virtual_device = make_virtual_device(M.virtual_port)
    end
    vp.device = M.virtual_device
  end
  frame_for(M.virtual_port)
end

local function install_arc_wrappers()
  if M.wrapped or not arc or not arc.vports then return end
  M.wrapped = true
  for port=1,4 do
    local vp = arc.vports[port]
    if vp then
      M.originals[port] = {
        led = vp.led,
        all = vp.all,
        refresh = vp.refresh,
        segment = vp.segment,
        intensity = vp.intensity,
      }
      local original = M.originals[port]
      vp.led = function(self, ring, led, value, relative)
        set_led(port, ring, led, value, relative)
        if original.led then return original.led(self, ring, led, value, relative) end
      end
      vp.all = function(self, value, relative)
        set_all(port, value, relative)
        if original.all then return original.all(self, value, relative) end
      end
      vp.segment = function(self, ring, from, to, level, relative)
        set_segment(port, ring, from, to, level, relative)
        if original.segment then return original.segment(self, ring, from, to, level, relative) end
      end
      vp.refresh = function(self)
        local result
        if original.refresh then result = original.refresh(self) end
        send_frame(port, false)
        return result
      end
      vp.intensity = function(self, value)
        local frame = frame_for(port)
        frame.intensity = math.floor(clamp(value, 0, 15))
        frame.dirty = true
        if original.intensity then return original.intensity(self, value) end
      end
    end
  end

  if arc.update_devices and not M.original_arc_update then
    M.original_arc_update = arc.update_devices
    arc.update_devices = function(...)
      local result = M.original_arc_update(...)
      attach_virtual()
      return result
    end
  end
end

local function dispatch_delta(port, ring, delta)
  port = strict_integer(port, 'arc port', 1, 4)
  ring = strict_integer(ring, 'arc ring', 1, 4)
  delta = strict_integer(delta, 'arc delta', -127, 127)
  local vp = arc.vports[port]
  if not vp then error('arc port not found') end
  local handled = false
  if vp.device and not vp.device._ingenue_virtual and vp.device.delta then
    vp.device.delta(ring, delta)
    handled = true
  end
  if vp.delta then
    vp.delta(ring, delta)
    handled = true
  end
  if not handled then error('arc port has no delta handler') end
end

local function dispatch_key(port, ring, state)
  port = strict_integer(port, 'arc port', 1, 4)
  ring = strict_integer(ring, 'arc key', 1, 4)
  state = strict_integer(state, 'arc key state', 0, 1)
  local vp = arc.vports[port]
  if not vp then error('arc port not found') end
  local handled = false
  if vp.device and not vp.device._ingenue_virtual and vp.device.key then
    vp.device.key(ring, state)
    handled = true
  end
  if vp.key then
    vp.key(ring, state)
    handled = true
  end
  if not handled then error('arc port has no key handler') end
end

local function execute(args, action)
  if action == 'delta' then
    dispatch_delta(args[4], args[5], args[6])
  elseif action == 'key' then
    dispatch_key(args[4], args[5], args[6])
  else
    error('unsupported Arc command arc.' .. tostring(action))
  end
end

local function pre_init()
  read_state_port()
  install_arc_wrappers()
  attach_virtual()
end

local function post_init()
  install_arc_wrappers()
  attach_virtual()
  for port=1,4 do
    if arc.vports[port] and arc.vports[port].device then send_frame(port, true) end
  end
end

local function post_cleanup()
  for port, frame in pairs(M.frames) do
    for i=1,#frame.values do frame.values[i] = 0 end
    frame.dirty = true
    send_frame(port, true)
  end
end

dispatcher.register_handler('arc', execute)
install_arc_wrappers()
attach_virtual()
mods.hook.register('script_pre_init', 'ingenue Arc pre-init', pre_init)
mods.hook.register('script_post_init', 'ingenue Arc post-init', post_init)
mods.hook.register('script_post_cleanup', 'ingenue Arc post-cleanup', post_cleanup)

return M
