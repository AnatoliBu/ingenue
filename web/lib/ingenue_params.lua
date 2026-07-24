-- Ingenue authoritative parameter catalog for automatic browser panels.
local mods = require 'core/mods'
local dispatcher = require 'ingenue_midi'

local M = {generation=0}

local function send(path, args)
  local port = 7779
  local candidates = {
    _path.code .. 'ingenue/data/realtime-state-port',
    _path.code .. 'ingenue/web/data/realtime-state-port',
  }
  for _, candidate in ipairs(candidates) do
    local file = io.open(candidate, 'r')
    if file then
      local value = tonumber(file:read('*l'))
      file:close()
      if value and value > 0 and value < 65536 then port = value; break end
    end
  end
  local ok, err = pcall(osc.send, {'127.0.0.1', port}, path, args)
  if not ok then print('ingenue parameter catalog send failed: ' .. tostring(err)) end
end

local function clamp(value, low, high)
  if value < low then return low end
  if value > high then return high end
  return value
end

local function eligible(param)
  return param and (param.t == 0 or param.t == 1 or param.t == 2 or param.t == 3 or
    param.t == 5 or param.t == 6 or param.t == 7 or param.t == 9)
end

local function visible(index)
  return not params.hidden or params.hidden[index] ~= true
end

local function kind_for(param)
  if param.t == 0 then return 'separator' end
  if param.t == 1 then return 'number' end
  if param.t == 2 then return 'option' end
  if param.t == 3 then return 'control' end
  if param.t == 5 then return 'taper' end
  if param.t == 6 then return 'trigger' end
  if param.t == 7 then return 'group' end
  if param.t == 9 and tostring(param.behavior or '') == 'trigger' then return 'trigger' end
  if param.t == 9 then return 'binary' end
  error('unsupported parameter type')
end

local function descriptor(param)
  local kind = kind_for(param)
  if kind == 'separator' or kind == 'group' then
    return kind, 0, '', '', '', '', '', 0, 0
  end
  if kind == 'trigger' then
    return kind, 0, '', '', '', '', tostring(param.behavior or ''), 1, 0
  end

  local range = param.get_range and param:get_range() or {0, 1}
  local min = tonumber(range and range[1]) or 0
  local max = tonumber(range and range[2]) or 1
  local raw_value = param.get and param:get() or 0
  local value = tonumber(raw_value) or 0
  local normalized
  if param.t == 3 or param.t == 5 then
    normalized = tonumber(param:get_raw()) or 0
  else
    normalized = max == min and 0 or (value - min) / (max - min)
  end
  local ok, formatted = pcall(function() return tostring(param:string()) end)
  if not ok then formatted = tostring(raw_value or '') end
  local options = param.t == 2 and tonumber(param.count) or 0
  return kind, clamp(normalized, 0, 1), tostring(raw_value or ''), tostring(min), tostring(max),
    formatted, tostring(param.behavior or ''), 1, options
end

local function publish_catalog()
  M.generation = M.generation + 1
  local generation = tostring(M.generation)
  local entries = {}
  for index, param in ipairs(params.params or {}) do
    if eligible(param) and visible(index) and #entries < 512 then table.insert(entries, param) end
  end
  local script_name = (norns.state and norns.state.name) or 'none'
  send('/ingenue/params/start', {generation, #entries, tostring(script_name)})
  for index, param in ipairs(entries) do
    local kind, normalized, value, min, max, formatted, behavior, writable, option_count = descriptor(param)
    send('/ingenue/params/item', {
      generation, index, param.t, tostring(param.id or ('param-' .. index)),
      tostring(param.name or param.id or ('Param ' .. index)), kind, normalized,
      value, min, max, formatted, behavior, writable, option_count,
    })
    if param.t == 2 then
      for option_index=1,option_count do
        send('/ingenue/params/option', {
          generation, index, option_index, tostring(param.options[option_index] or option_index),
        })
      end
    end
  end
  send('/ingenue/params/end', {generation, #entries})
  return {'params', 'catalog', generation, #entries}
end

local function trigger(id)
  id = tostring(id or '')
  if id == '' then error('param id is required') end
  local param = params:lookup_param(id)
  local behavior = tostring(param.behavior or '')
  if param.t ~= 6 and not (param.t == 9 and behavior == 'trigger') then
    error('parameter is not a trigger')
  end
  params:set(id, 1)
  return {'params', 'trigger', id}
end

local function handler(args, action)
  if action == 'catalog' then return publish_catalog() end
  if action == 'trigger' then return trigger(args[4]) end
  error('unsupported parameter catalog command')
end

local function clear_catalog()
  M.generation = M.generation + 1
  local generation = tostring(M.generation)
  send('/ingenue/params/start', {generation, 0, 'none'})
  send('/ingenue/params/end', {generation, 0})
end

local function publish_after_init()
  local ok, err = pcall(publish_catalog)
  if not ok then print('ingenue parameter catalog failed: ' .. tostring(err)) end
end

dispatcher.register_handler('params', handler)
mods.hook.register('script_post_init', 'ingenue parameter catalog', publish_after_init)
mods.hook.register('script_post_cleanup', 'ingenue parameter catalog cleanup', clear_catalog)

return M
