-- Ingenue Web MIDI normalized-parameter adapter.
local mods = require 'core/mods'

local M = {state_port=7779, previous_osc_event=nil, osc_wrapper=nil}

local function finite(value, label)
  if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge then
    error(label .. ' must be finite')
  end
  return value
end

local function clamp(value, low, high)
  if value < low then return low end
  if value > high then return high end
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
      if value and value > 0 and value < 65536 then M.state_port = value return end
    end
  end
end

local function send(path, args)
  local ok, err = pcall(osc.send, {'127.0.0.1', M.state_port}, path, args)
  if not ok then print('ingenue MIDI send failed: ' .. tostring(err)) end
end

local function param_by_id(id)
  id = tostring(id or '')
  if id == '' then error('param id is required') end
  local ok, param = pcall(params.lookup_param, params, id)
  if not ok or not param then error('parameter not found: ' .. id) end
  return id, param
end

local function normalized_value(param)
  if param.t == params.tCONTROL or param.t == params.tTAPER then
    return clamp(finite(param:get_raw(), 'raw parameter value'), 0, 1)
  elseif param.t == params.tNUMBER then
    if param.max == param.min then return 0 end
    return clamp((param:get() - param.min) / (param.max - param.min), 0, 1)
  elseif param.t == params.tOPTION then
    if param.count <= 1 then return 0 end
    return clamp((param:get() - 1) / (param.count - 1), 0, 1)
  elseif param.t == params.tBINARY then
    return param:get() > 0 and 1 or 0
  end
  error('unsupported parameter type')
end

local function kind_for(param)
  if param.t == params.tNUMBER then return 'number' end
  if param.t == params.tOPTION then return 'option' end
  if param.t == params.tCONTROL then return 'control' end
  if param.t == params.tTAPER then return 'taper' end
  if param.t == params.tBINARY then return param.behavior == 'trigger' and 'trigger' or 'binary' end
  error('unsupported parameter type')
end

local function range_for(param)
  if param.t == params.tNUMBER then return param.min, param.max end
  if param.t == params.tOPTION then return 1, param.count end
  if param.t == params.tCONTROL then return param.controlspec.minval, param.controlspec.maxval end
  if param.t == params.tTAPER then return param.min, param.max end
  if param.t == params.tBINARY then return 0, 1 end
  error('unsupported parameter type')
end

local function descriptor(param_id, param)
  local minimum, maximum = range_for(param)
  local value = param:get()
  local ok, formatted = pcall(param.string, param)
  if not ok then formatted = tostring(value) end
  local behavior = param.behavior or ''
  local writable = not (param.t == params.tBINARY and behavior == 'trigger')
  return {
    'param', param_id, param.t, kind_for(param), normalized_value(param),
    tostring(value), tostring(minimum), tostring(maximum),
    tostring(param.name or param_id), tostring(formatted), tostring(behavior), writable and 1 or 0,
  }
end

local function set_normalized(param, value)
  value = clamp(finite(value, 'normalized parameter value'), 0, 1)
  if param.t == params.tCONTROL or param.t == params.tTAPER then
    param:set_raw(value)
  elseif param.t == params.tNUMBER then
    param:set(math.floor(param.min + value * (param.max - param.min) + 0.5))
  elseif param.t == params.tOPTION then
    param:set(math.floor(1 + value * math.max(0, param.count - 1) + 0.5))
  elseif param.t == params.tBINARY then
    if param.behavior == 'trigger' then error('trigger parameters are not writable from absolute MIDI') end
    param:set(value >= 0.5 and 1 or 0)
  else
    error('unsupported parameter type')
  end
end

local function execute(args)
  local wire_id = tostring(args[1] or '')
  local target = tostring(args[2] or '')
  local action = tostring(args[3] or '')
  if wire_id == '' then error('command id is required') end
  if target ~= 'param' then error('unsupported MIDI target') end
  local param_id, param = param_by_id(args[4])
  if action == 'describe' then
  elseif action == 'set_normalized' then
    set_normalized(param, args[5])
  elseif action == 'delta' then
    local delta = args[5]
    if type(delta) ~= 'number' or delta ~= math.floor(delta) or delta < -127 or delta > 127 then
      error('parameter delta must be an integer between -127 and 127')
    end
    params:delta(param_id, delta)
  else
    error('unsupported MIDI action ' .. action)
  end
  local result = {wire_id}
  for _, value in ipairs(descriptor(param_id, param)) do table.insert(result, value) end
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
    if path == '/ingenue/midi-command' then handle(args or {}) return end
    if M.previous_osc_event then return M.previous_osc_event(path, args, from) end
  end
  osc.event = M.osc_wrapper
end

local function pre_init() read_state_port(); install_wrapper() end
local function post_init() install_wrapper() end
local function post_cleanup()
  if osc.event == M.osc_wrapper then osc.event = M.previous_osc_event end
  M.previous_osc_event = nil
  M.osc_wrapper = nil
end

install_wrapper()
mods.hook.register('script_pre_init', 'ingenue MIDI pre-init', pre_init)
mods.hook.register('script_post_init', 'ingenue MIDI post-init', post_init)
mods.hook.register('script_post_cleanup', 'ingenue MIDI post-cleanup', post_cleanup)

return M
