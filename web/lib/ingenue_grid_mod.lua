-- Ingenue realtime Lua adapter.
-- Executes browser commands inside matron, returns applied ack/reject over a
-- localhost OSC bridge, and mirrors Grid LED frames without replacing a
-- connected physical Grid.

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
  previous_osc_event = nil,
  osc_wrapper = nil,
}

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

local function strict_number(value, label)
  if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge then
    error(label .. ' must be finite')
  end
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

local function dispatch_grid_key(port, x, y, z)
  port = strict_integer(port, 'grid port', 1, 4)
  local vp = grid.vports[port]
  if not vp then error('grid port not found') end
  local cols = math.max(1, vp.cols or M.virtual_cols)
  local rows = math.max(1, vp.rows or M.virtual_rows)
  x = strict_integer(x, 'grid x', 1, cols)
  y = strict_integer(y, 'grid y', 1, rows)
  z = strict_integer(z, 'grid state', 0, 1)
  local handled = false
  if vp.device and not vp.device._ingenue_virtual and vp.device.key then
    vp.device.key(x, y, z)
    handled = true
  end
  if vp.key then
    vp.key(x, y, z)
    handled = true
  end
  if not handled then error('grid port has no key handler') end
end

local function execute_command(args)
  local id = tostring(args[1] or '')
  local target = tostring(args[2] or '')
  local action = tostring(args[3] or '')
  if id == '' then error('command id is required') end

  if target == 'control' and action == 'enc' then
    _norns.enc(strict_integer(args[4], 'encoder', 1, 3),
      strict_integer(args[5], 'delta', -127, 127))
  elseif target == 'control' and action == 'key' then
    _norns.key(strict_integer(args[4], 'key', 1, 3),
      strict_integer(args[5], 'key state', 0, 1))
  elseif target == 'param' and action == 'set' then
    local param_id = tostring(args[4] or '')
    if param_id == '' then error('param id is required') end
    params:set(param_id, strict_number(args[5], 'param value'))
  elseif target == 'grid' and action == 'key' then
    dispatch_grid_key(args[4], args[5], args[6], args[7])
  else
    error('unsupported command ' .. target .. '.' .. action)
  end
  return id
end

local function handle_command(args)
  local id = tostring(args[1] or '')
  local ok, result = pcall(execute_command, args)
  if ok then
    -- The bridge correlates the first ACK argument with its pending wire id.
    send('/ingenue/ack', {id})
  else
    send('/ingenue/reject', {id, tostring(result)})
  end
end

local function install_osc_wrapper()
  if osc.event == M.osc_wrapper then return end
  M.previous_osc_event = osc.event
  M.osc_wrapper = function(path, args, from)
    if path == '/ingenue/command' then
      handle_command(args or {})
      return
    end
    if M.previous_osc_event then return M.previous_osc_event(path, args, from) end
  end
  osc.event = M.osc_wrapper
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
  install_osc_wrapper()
end

local function post_init()
  -- A script may assign osc.event inside init(), after script_pre_init. Re-wrap
  -- here so the latest script handler remains chained behind Ingenue commands.
  install_osc_wrapper()
  send_script_state(true)
  for port=1,4 do
    if grid.vports[port] and grid.vports[port].device then send_frame(port, true) end
  end
end

local function post_cleanup()
  send_script_state(false)
  if osc.event == M.osc_wrapper then osc.event = M.previous_osc_event end
  M.previous_osc_event = nil
  M.osc_wrapper = nil
end

install_grid_wrappers()
attach_virtual()
mods.hook.register('script_pre_init', 'ingenue realtime pre-init', pre_init)
mods.hook.register('script_post_init', 'ingenue realtime post-init', post_init)
mods.hook.register('script_post_cleanup', 'ingenue realtime post-cleanup', post_cleanup)

return M
