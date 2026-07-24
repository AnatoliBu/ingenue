-- Configurable virtual Grid profiles layered over the tested Ingenue Grid adapter.
local mods = require 'core/mods'
local grid_adapter = require 'ingenue_grid_mod'
local dispatcher = require 'ingenue_midi'

local M = {
  config = {port=1, cols=16, rows=8, rotation=0},
}

local CONFIG_PATH = _path.code .. 'ingenue/data/virtual-grid-config'

local function strict_integer(value, label, low, high)
  if type(value) ~= 'number' or value ~= math.floor(value) then error(label .. ' must be an integer') end
  if value < low or value > high then error(label .. ' must be between ' .. low .. ' and ' .. high) end
  return value
end

local function valid_shape(cols, rows)
  return (cols == 8 and rows == 8) or (cols == 16 and rows == 8) or (cols == 16 and rows == 16)
end

local function parse_config(line)
  local port, cols, rows, rotation = tostring(line or ''):match('^(%d+),(%d+),(%d+),(%d+)$')
  port, cols, rows, rotation = tonumber(port), tonumber(cols), tonumber(rows), tonumber(rotation)
  if not port or port < 1 or port > 4 or not valid_shape(cols, rows) or rotation < 0 or rotation > 3 then return nil end
  return {port=port, cols=cols, rows=rows, rotation=rotation}
end

local function read_config()
  local file = io.open(CONFIG_PATH, 'r')
  if not file then return end
  local parsed = parse_config(file:read('*l'))
  file:close()
  if parsed then M.config = parsed end
end

local function persist_config(config)
  local file, err = io.open(CONFIG_PATH, 'w')
  if not file then error('could not persist virtual Grid config: ' .. tostring(err)) end
  file:write(string.format('%d,%d,%d,%d\n', config.port, config.cols, config.rows, config.rotation))
  file:close()
end

local function send(path, args)
  local ok, err = pcall(osc.send, {'127.0.0.1', grid_adapter.state_port}, path, args)
  if not ok then print('ingenue Grid hardening send failed: ' .. tostring(err)) end
end

local function oriented_shape(config)
  if config.rotation % 2 == 1 then return config.rows, config.cols end
  return config.cols, config.rows
end

local function encode_frame(frame)
  local out = {}
  for i=1,#frame.values do
    out[i] = string.format('%x', math.floor(math.max(0, math.min(15, frame.values[i] or 0))))
  end
  return table.concat(out)
end

local function send_frame(port, force)
  local frame = grid_adapter.frames[port]
  local vp = grid and grid.vports and grid.vports[port]
  if not frame or not vp or not vp.device then return end
  if not force and not frame.dirty then return end
  frame.sequence = (frame.sequence or 0) + 1
  frame.dirty = false
  send('/ingenue/grid/frame', {
    port, frame.cols, frame.rows, encode_frame(frame), frame.sequence,
    frame.intensity or 15, vp.device._ingenue_virtual and 1 or 0,
    (port == M.config.port and vp.device._ingenue_virtual) and M.config.rotation or 0,
  })
end

local function reset_frame(port, cols, rows)
  local old = grid_adapter.frames[port]
  local frame = {
    cols=cols,
    rows=rows,
    values={},
    dirty=true,
    sequence=old and old.sequence or 0,
    intensity=old and old.intensity or 15,
  }
  for i=1,cols*rows do frame.values[i] = old and old.values[i] or 0 end
  grid_adapter.frames[port] = frame
  return frame
end

local function update_virtual_device(config)
  local device = grid_adapter.virtual_device
  if not device then return end
  local cols, rows = oriented_shape(config)
  device.port = config.port
  device.cols = cols
  device.rows = rows
  device.rotation = function(_self, value)
    value = strict_integer(value, 'grid rotation', 0, 3)
    M.config.rotation = value
    local oriented_cols, oriented_rows = oriented_shape(M.config)
    device.cols, device.rows = oriented_cols, oriented_rows
    local vp = grid.vports[M.config.port]
    if vp and vp.device == device then vp.cols, vp.rows = oriented_cols, oriented_rows end
    reset_frame(M.config.port, oriented_cols, oriented_rows)
    send_frame(M.config.port, true)
  end
end

local function detach_virtual(port)
  local vp = grid and grid.vports and grid.vports[port]
  if vp and vp.device and vp.device._ingenue_virtual then
    vp.device = nil
    vp.cols, vp.rows = 0, 0
    grid_adapter.frames[port] = nil
    send('/ingenue/grid/disconnect', {port})
  end
end

local function apply_config(config)
  local target = grid and grid.vports and grid.vports[config.port]
  if not target then error('grid vport not found') end
  if target.device and not target.device._ingenue_virtual then
    error('target grid vport is occupied by a physical device')
  end

  local old_port = grid_adapter.virtual_port
  if old_port ~= config.port then detach_virtual(old_port) end
  grid_adapter.virtual_port = config.port
  grid_adapter.virtual_cols = config.cols
  grid_adapter.virtual_rows = config.rows
  M.config = {port=config.port, cols=config.cols, rows=config.rows, rotation=config.rotation}
  update_virtual_device(M.config)

  if grid.update_devices then grid.update_devices() end
  update_virtual_device(M.config)
  local vp = grid.vports[config.port]
  if not vp or not vp.device or not vp.device._ingenue_virtual then
    error('virtual Grid could not attach to requested vport')
  end
  local cols, rows = oriented_shape(M.config)
  vp.cols, vp.rows = cols, rows
  reset_frame(config.port, cols, rows)
  send_frame(config.port, true)
end

local function dispatch_grid_key(args)
  local port = strict_integer(args[4], 'grid port', 1, 4)
  local vp = grid and grid.vports and grid.vports[port]
  if not vp then error('grid port not found') end
  local cols = math.max(1, vp.cols or grid_adapter.virtual_cols)
  local rows = math.max(1, vp.rows or grid_adapter.virtual_rows)
  local x = strict_integer(args[5], 'grid x', 1, cols)
  local y = strict_integer(args[6], 'grid y', 1, rows)
  local z = strict_integer(args[7], 'grid state', 0, 1)
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

local function execute(args, action)
  if action == 'key' then
    dispatch_grid_key(args)
    return
  end
  if action ~= 'configure' then error('unsupported Grid command grid.' .. tostring(action)) end
  local config = {
    port = strict_integer(args[4], 'grid port', 1, 4),
    cols = strict_integer(args[5], 'grid cols', 1, 32),
    rows = strict_integer(args[6], 'grid rows', 1, 32),
    rotation = strict_integer(args[7], 'grid rotation', 0, 3),
  }
  if not valid_shape(config.cols, config.rows) then error('grid shape must be 8x8, 16x8, or 16x16') end
  local target = grid and grid.vports and grid.vports[config.port]
  if target and target.device and not target.device._ingenue_virtual then
    error('target grid vport is occupied by a physical device')
  end
  persist_config(config)
  apply_config(config)
end

local function pre_init()
  read_config()
  local ok, err = pcall(apply_config, M.config)
  if not ok then print('ingenue virtual Grid profile inactive: ' .. tostring(err)) end
end

local function post_init()
  send_frame(M.config.port, true)
end

dispatcher.register_handler('grid', execute)
read_config()
mods.hook.register('script_pre_init', 'ingenue Grid profile pre-init', pre_init)
mods.hook.register('script_post_init', 'ingenue Grid profile post-init', post_init)

return M
