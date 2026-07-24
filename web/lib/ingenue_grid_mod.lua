-- Ingenue realtime Grid state adapter.
-- Mirrors Grid LED frames without replacing a connected physical Grid. All
-- browser command OSC is owned by ingenue_midi.lua's shared dispatcher.

local mods = require 'core/mods'

local M = {
  state_port = 7779,
  virtual_port = 1,
  virtual_cols = 16,
  virtual_rows = 8,
  frames = {},
  originals = {},
  wrapped = false,
  virtual_device = nil,
}

local function clamp(value, low, high)
  value = tonumber(value) or 0
  if value < low then return low end
  if value > high then return high end
  return value
end

local function read_state_port()
  -- Current installs copy web/ flat into dust/code/ingenue. The second path
  -- keeps older nested dust/code/ingenue/web layouts compatible with the
  -- installer's documented fallback WORK directory.
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
  if not ok then print('ingenue realtime send failed: ' .. tostring(err)) end
end

local function frame_for(port)
  local vp = grid.vports[port]
  local cols = math.floor(clamp((vp and vp.cols) or 0, 0, 32))
  local rows = math.floor(clamp((vp and vp.rows) or 0, 0, 32))
  if cols == 0 then cols = M.virtual_cols end
  if rows == 0 then rows = M.virtual_rows end
  local frame = M.frames[port]
  if frame == nil or frame.cols ~= cols or frame.rows ~= rows then
    frame = {cols=cols, rows=rows, values={}, dirty=true, sequence=0, intensity=15}
    for i=1,cols*rows do frame.values[i] = 0 end
    M.frames[port] = frame
  end
  return frame
end

local function frame_index(frame, x, y)
  if x < 1 or x > frame.cols or y < 1 or y > frame.rows then return nil end
  return (y - 1) * frame.cols + x
end

local function set_led(port, x, y, value, relative)
  local frame = frame_for(port)
  x = math.floor(clamp(x, 1, frame.cols))
  y = math.floor(clamp(y, 1, frame.rows))
  local index = frame_index(frame, x, y)
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

local function encode_frame(frame)
  local out = {}
  for i=1,#frame.values do out[i] = string.format('%x', math.floor(clamp(frame.values[i], 0, 15))) end
  return table.concat(out)
end

local function send_frame(port, force)
  local frame = frame_for(port)
  if not force and not frame.dirty then return end
  frame.sequence = frame.sequence + 1
  frame.dirty = false
  local vp = grid.vports[port]
  local virtual = vp and vp.device and vp.device._ingenue_virtual and 1 or 0
  send('/ingenue/grid/frame', {
    port, frame.cols, frame.rows, encode_frame(frame), frame.sequence,
    frame.intensity or 15, virtual
  })
end

local function make_virtual_device(port)
  return {
    id = -1000 - port,
    serial = 'browser',
    name = 'ingenue virtual grid',
    port = port,
    cols = M.virtual_cols,
    rows = M.virtual_rows,
    _ingenue_virtual = true,
    led = function() end,
    all = function() end,
    refresh = function() end,
    intensity = function() end,
    rotation = function() end,
    tilt_enable = function() end,
  }
end

local function attach_virtual()
  if not grid or not grid.vports then return end
  local vp = grid.vports[M.virtual_port]
  if not vp then return end
  if vp.device == nil then
    if M.virtual_device == nil then M.virtual_device = make_virtual_device(M.virtual_port) end
    vp.device = M.virtual_device
    vp.cols = M.virtual_device.cols
    vp.rows = M.virtual_device.rows
  end
  frame_for(M.virtual_port)
end

local function install_grid_wrappers()
  if M.wrapped or not grid or not grid.vports then return end
  M.wrapped = true
  for port=1,4 do
    local vp = grid.vports[port]
    if vp then
      M.originals[port] = {
        led = vp.led,
        all = vp.all,
        refresh = vp.refresh,
        intensity = vp.intensity,
      }
      local original = M.originals[port]
      vp.led = function(self, x, y, value, relative)
        set_led(port, x, y, value, relative)
        if original.led then return original.led(self, x, y, value, relative) end
      end
      vp.all = function(self, value, relative)
        set_all(port, value, relative)
        if original.all then return original.all(self, value, relative) end
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

  if grid.update_devices and not M.original_grid_update then
    M.original_grid_update = grid.update_devices
    grid.update_devices = function(...)
      local result = M.original_grid_update(...)
      attach_virtual()
      return result
    end
  end
end

local function send_script_state(active)
  send('/ingenue/script/state', {
    active and 1 or 0,
    (norns.state and norns.state.name) or 'none',
    (norns.state and norns.state.shortname) or 'none'
  })
end

local function pre_init()
  read_state_port()
  install_grid_wrappers()
  attach_virtual()
end

local function post_init()
  send_script_state(true)
  for port=1,4 do
    if grid.vports[port] and grid.vports[port].device then send_frame(port, true) end
  end
end

local function post_cleanup()
  send_script_state(false)
end

install_grid_wrappers()
attach_virtual()
mods.hook.register('script_pre_init', 'ingenue realtime pre-init', pre_init)
mods.hook.register('script_post_init', 'ingenue realtime post-init', post_init)
mods.hook.register('script_post_cleanup', 'ingenue realtime cleanup', post_cleanup)

return M
