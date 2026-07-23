-- Ingenue normalized parameter bridge for browser-hosted Web MIDI.
local mods = require 'core/mods'

local M = {previous_osc_event=nil, osc_wrapper=nil}

local function clamp(value, low, high)
  if value < low then return low end
  if value > high then return high end
  return value
end

local function strict_number(value, label)
  if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge then
    error(label .. ' must be finite')
  end
  return value
end

local function strict_integer(value, label, low, high)
  if type(value) ~= 'number' or value ~= math.floor(value) then error(label .. ' must be an integer') end
  if value < low or value > high then error(label .. ' must be between ' .. low .. ' and ' .. high) end
  return value
end

local function round(value)
  return value >= 0 and math.floor(value + 0.5) or math.ceil(value - 0.5)
end

local function send(path, args)
  local port = 7779
  local candidates = {
    _path.code .. 'ingenue/data/realtime-state-port',
    _path.code .. 'ingenue/web/data/realtime-state-port',
  }
  for _, path in ipairs(candidates) do
    local file = io.open(path, 'r')
    if file then
      local value = tonumber(file:read('*l'))
      file:close()
      if value and value > 0 and value < 65536 then port = value; break end
    end
  end
  local ok, err = pcall(osc.send, {'127.0.0.1', port}, path, args)
  if not ok then print('ingenue MIDI send failed: ' .. tostring(err)) end
end

local function get_param(id)
  id = tostring(id or '')
  if id == '' then error('param id is required') end
  return id, params:lookup_param(id)
end

local function descriptor(id)
  local param_id, param = get_param(id)
  local range = param:get_range()
  local min = tonumber(range and range[1]) or 0
  local max = tonumber(range and range[2]) or 1
  local value = tonumber(param:get()) or 0
  local normalized, kind, behavior, writable
  behavior = tostring(param.behavior or '')
  writable = 1

  if param.t == 3 then
    kind = 'control'; normalized = param:get_raw()
  elseif param.t == 5 then
    kind = 'taper'; normalized = param:get_raw()
  elseif param.t == 1 then
    kind = 'number'; normalized = max == min and 0 or (value - min) / (max - min)
  elseif param.t == 2 then
    kind = 'option'; normalized = max == min and 0 or (value - min) / (max - min)
  elseif param.t == 9 then
    kind = behavior == 'trigger' and 'trigger' or 'binary'
    normalized = behavior == 'trigger' and 0 or clamp(value, 0, 1)
    if behavior == 'trigger' then writable = 0 end
  else
    error('param type is not MIDI-normalizable')
  end

  local ok, formatted = pcall(function() return tostring(param:string()) end)
  if not ok then formatted = tostring(value) end
  return {
    'param', param_id, param.t, kind, clamp(normalized, 0, 1), tostring(value),
    tostring(min), tostring(max), tostring(param.name or param_id), formatted, behavior, writable
  }
end

local function set_normalized(id, raw)
  local param_id, param = get_param(id)
  local normalized = clamp(strict_number(raw, 'normalized parameter value'), 0, 1)
  if param.t == 3 or param.t == 5 then
    param:set_raw(normalized)
  elseif param.t == 1 then
    param:set(round(param.min + normalized * (param.max - param.min)))
  elseif param.t == 2 then
    param:set(1 + round(normalized * (param.count - 1)))
  elseif param.t == 9 and param.behavior ~= 'trigger' then
    param:set(normalized >= 0.5 and 1 or 0)
  elseif param.t == 9 then
    error('trigger parameters are not writable')
  else
    error('param type is not MIDI-normalizable')
  end
  return descriptor(param_id)
end

local function execute(args)
  local wire_id = tostring(args[1] or '')
  local target = tostring(args[2] or '')
  local action = tostring(args[3] or '')
  if wire_id == '' then error('command id is required') end
  if target ~= 'param' then error('unsupported MIDI target') end

  local descriptor_result
  if action == 'describe' then
    descriptor_result = descriptor(args[4])
  elseif action == 'set_normalized' then
    descriptor_result = set_normalized(args[4], args[5])
  elseif action == 'delta' then
    local id = tostring(args[4] or '')
    get_param(id)
    params:delta(id, strict_integer(args[5], 'parameter delta', -127, 127))
    descriptor_result = descriptor(id)
  else
    error('unsupported MIDI command param.' .. action)
  end
  local result = {wire_id}
  for _, value in ipairs(descriptor_result) do table.insert(result, value) end
  return result
end

local function handle(args)
  local wire_id = tostring(args[1] or '')
  local ok, result = pcall(execute, args)
  if ok then send('/ingenue/ack', result)
  else send('/ingenue/reject', {wire_id, tostring(result)}) end
end

local function install_wrapper()
  if osc.event == M.osc_wrapper then return end
  M.previous_osc_event = osc.event
  M.osc_wrapper = function(path, args, from)
    if path == '/ingenue/midi-command' then handle(args or {}); return end
    if M.previous_osc_event then return M.previous_osc_event(path, args, from) end
  end
  osc.event = M.osc_wrapper
end

local function post_init() install_wrapper() end

local function cleanup()
  if osc.event == M.osc_wrapper then osc.event = M.previous_osc_event end
  M.previous_osc_event = nil
  M.osc_wrapper = nil
end

mods.hook.register('script_pre_init', 'ingenue MIDI pre-init', install_wrapper)
mods.hook.register('script_post_init', 'ingenue MIDI post-init', post_init)
mods.hook.register('script_post_cleanup', 'ingenue MIDI cleanup', cleanup)

return M
