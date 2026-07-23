-- Ingenue realtime adapter
-- Executes browser commands inside matron and mirrors one Grid vport.
local mod = require 'core/mods'

local VERSION = "1"
local DEFAULT_REPLY_PORT = 10112
local reply_host = "127.0.0.1"
local reply_port = DEFAULT_REPLY_PORT
local previous_osc_event = nil
local installed = false
local grid_wrapped = false

local virtual = {
  port = 1,
  cols = 16,
  rows = 8,
  levels = {},
}

local original_grid_methods = {}
local original_update_devices = nil

local function clamp(value, low, high)
  value = tonumber(value) or 0
  value = math.floor(value + 0.5)
  if value < low then return low end
  if value > high then return high end
  return value
end

local function reset_levels(cols, rows)
  virtual.cols = clamp(cols or virtual.cols, 1, 32)
  virtual.rows = clamp(rows or virtual.rows, 1, 16)
  virtual.levels = {}
  for i = 1, virtual.cols * virtual.rows do
    virtual.levels[i] = 0
  end
end

reset_levels(virtual.cols, virtual.rows)

local function level_index(x, y)
  return (y - 1) * virtual.cols + x
end

local function levels_hex()
  local out = {}
  for i = 1, virtual.cols * virtual.rows do
    out[i] = string.format("%x", clamp(virtual.levels[i] or 0, 0, 15))
  end
  return table.concat(out)
end

local function send(path, args)
  local ok, err = pcall(osc.send, {reply_host, reply_port}, path, args)
  if not ok then
    print("ingenue adapter send failed: " .. tostring(err))
  end
end

local function send_hello()
  send("/ingenue/hello", {VERSION})
end

local function send_grid()
  send("/ingenue/grid", {
    virtual.port,
    virtual.cols,
    virtual.rows,
    levels_hex(),
  })
end

local function decode_args(raw)
  if raw == nil or raw == "" then return {} end
  local codec = json or _json
  if codec == nil or codec.decode == nil then
    error("JSON decoder unavailable")
  end
  local ok, value = pcall(codec.decode, raw)
  if not ok or type(value) ~= "table" then
    error("invalid command args JSON")
  end
  return value
end

local function integer(value, label, low, high)
  local number = tonumber(value)
  if number == nil or number ~= math.floor(number) then
    error(label .. " must be an integer")
  end
  if number < low or number > high then
    error(label .. " out of range")
  end
  return number
end

local function execute(target, action, args)
  if target == "control" and action == "enc" then
    local n = integer(args.n, "encoder", 1, 3)
    local d = integer(args.d, "delta", -127, 127)
    _norns.enc(n, d)
    return
  end

  if target == "control" and action == "key" then
    local n = integer(args.n, "key", 1, 3)
    local z = integer(args.z, "key state", 0, 1)
    _norns.key(n, z)
    return
  end

  if target == "param" and action == "set" then
    local id = tostring(args.id or "")
    local value = tonumber(args.value)
    if id == "" then error("param id required") end
    if value == nil or value ~= value or value == math.huge or value == -math.huge then
      error("param value must be finite")
    end
    local parameter = params:lookup_param(id)
    if parameter == nil then error("unknown param: " .. id) end
    params:set(id, value)
    return
  end

  if target == "grid" and action == "key" then
    local port = integer(args.port or virtual.port, "grid port", 1, 4)
    local x = integer(args.x, "grid x", 1, 32)
    local y = integer(args.y, "grid y", 1, 16)
    local z = integer(args.z, "grid key state", 0, 1)
    local vport = grid.vports[port]
    if vport == nil or type(vport.key) ~= "function" then
      error("grid port has no key handler")
    end
    vport.key(x, y, z)
    return
  end

  error("unsupported command: " .. tostring(target) .. "." .. tostring(action))
end

local function handle_command(args)
  local id = tostring(args[1] or "")
  local target = tostring(args[2] or "")
  local action = tostring(args[3] or "")
  local raw = tostring(args[4] or "")
  local port = tonumber(args[5])
  if port ~= nil then reply_port = clamp(port, 1024, 65535) end
  if id == "" then return end

  local ok, err = pcall(function()
    execute(target, action, decode_args(raw))
  end)
  if ok then
    send("/ingenue/ack", {id})
  else
    send("/ingenue/reject", {id, tostring(err)})
  end
end

local function osc_event(path, args, from)
  if path == "/ingenue/ping" then
    local port = tonumber(args and args[1])
    if port ~= nil then reply_port = clamp(port, 1024, 65535) end
    send_hello()
    send_grid()
    return
  elseif path == "/ingenue/command" then
    handle_command(args or {})
    return
  end

  if previous_osc_event ~= nil then
    return previous_osc_event(path, args, from)
  end
end

local function sync_virtual_dimensions(vport)
  if vport == nil then return end
  if vport.device ~= nil and tonumber(vport.cols) and tonumber(vport.rows)
      and vport.cols > 0 and vport.rows > 0 then
    if virtual.cols ~= vport.cols or virtual.rows ~= vport.rows then
      reset_levels(vport.cols, vport.rows)
    end
  elseif vport == grid.vports[virtual.port] then
    vport.cols = virtual.cols
    vport.rows = virtual.rows
  end
end

local function wrap_grid()
  if grid_wrapped or grid == nil or grid.vports == nil then return end
  grid_wrapped = true

  for port = 1, 4 do
    local vport = grid.vports[port]
    original_grid_methods[port] = {
      led = vport.led,
      all = vport.all,
      refresh = vport.refresh,
    }

    vport.led = function(self, x, y, value, relative)
      local original = original_grid_methods[port].led
      if original ~= nil then original(self, x, y, value, relative) end
      if port ~= virtual.port then return end
      sync_virtual_dimensions(self)
      x = clamp(x, 1, virtual.cols)
      y = clamp(y, 1, virtual.rows)
      local index = level_index(x, y)
      local next_value = relative and clamp(value, -15, 15) or clamp(value, 0, 15)
      if relative then next_value = clamp((virtual.levels[index] or 0) + next_value, 0, 15) end
      virtual.levels[index] = next_value
    end

    vport.all = function(self, value, relative)
      local original = original_grid_methods[port].all
      if original ~= nil then original(self, value, relative) end
      if port ~= virtual.port then return end
      sync_virtual_dimensions(self)
      local next_value = relative and clamp(value, -15, 15) or clamp(value, 0, 15)
      for i = 1, virtual.cols * virtual.rows do
        if relative then
          virtual.levels[i] = clamp((virtual.levels[i] or 0) + next_value, 0, 15)
        else
          virtual.levels[i] = next_value
        end
      end
    end

    vport.refresh = function(self)
      local original = original_grid_methods[port].refresh
      if original ~= nil then original(self) end
      if port == virtual.port then
        sync_virtual_dimensions(self)
        send_grid()
      end
    end
  end

  original_update_devices = grid.update_devices
  if original_update_devices ~= nil then
    grid.update_devices = function(...)
      local result = original_update_devices(...)
      sync_virtual_dimensions(grid.vports[virtual.port])
      return result
    end
  end
  sync_virtual_dimensions(grid.vports[virtual.port])
end

local function install()
  if not installed then
    previous_osc_event = _norns.osc.event
    _norns.osc.event = osc_event
    wrap_grid()
    installed = true
    print("ingenue realtime adapter installed")
  end
  send_hello()
  send_grid()
end

mod.hook.register("system_post_startup", "ingenue realtime adapter", install)
mod.hook.register("script_post_init", "ingenue realtime adapter hello", function()
  sync_virtual_dimensions(grid.vports[virtual.port])
  send_hello()
  send_grid()
end)

local api = {}
api.version = VERSION
api.status = function()
  return {
    installed = installed,
    reply_port = reply_port,
    grid_port = virtual.port,
    cols = virtual.cols,
    rows = virtual.rows,
  }
end

return api
