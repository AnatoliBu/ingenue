-- Read-only observer for tehn/mlr 2.2.5.
--
-- MLR remains authoritative. This adapter never calls softcut, never mutates the
-- script's tables and never replaces Grid/K/E callbacks. It only publishes a
-- compact snapshot of the running script to Ingenue's localhost state bridge.
local mods = require 'core/mods'

local M = {
  state_port = 7779,
  version = '2.2.5',
  timer = nil,
  active = false,
  signatures = {},
}

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
  if not ok then print('ingenue mlr observer send failed: ' .. tostring(err)) end
end

local function number(value, fallback)
  value = tonumber(value)
  if value == nil or value ~= value or value == math.huge or value == -math.huge then
    return fallback or 0
  end
  return value
end

local function integer(value, fallback)
  return math.floor(number(value, fallback or 0))
end

local function flag(value)
  if value == true or number(value, 0) ~= 0 then return 1 end
  return 0
end

local function short_text(value, limit)
  local text = tostring(value or '-')
  limit = limit or 256
  if #text > limit then text = string.sub(text, 1, limit) end
  return text
end

local function signature(values)
  local parts = {}
  for index, value in ipairs(values) do parts[index] = tostring(value) end
  return table.concat(parts, '\31')
end

local function publish_if_changed(key, path, values, force)
  local next_signature = signature(values)
  if force or M.signatures[key] ~= next_signature then
    M.signatures[key] = next_signature
    send(path, values)
  end
end

local function is_mlr()
  local state = norns and norns.state or nil
  local shortname = state and tostring(state.shortname or ''):lower() or ''
  local name = state and tostring(state.name or ''):lower() or ''
  return shortname == 'mlr' or name == 'mlr' or name:match('/mlr$') ~= nil
end

local function publish_meta(force)
  local view = integer(rawget(_G, 'view'), 1)
  local values = {
    M.active and 1 or 0,
    M.version,
    view,
    integer(rawget(_G, 'focus'), 1),
    flag(rawget(_G, 'alt')),
    flag(rawget(_G, 'quantize')),
  }
  publish_if_changed('meta', '/ingenue/mlr/meta', values, force)
end

local function publish_clip(index, force)
  local clips = rawget(_G, 'clip')
  local item = type(clips) == 'table' and clips[index] or nil
  local values = {
    index,
    short_text(item and item.name or '-', 256),
    number(item and item.l, 0),
    number(item and item.bpm, 0),
  }
  publish_if_changed('clip:' .. index, '/ingenue/mlr/clip', values, force)
end

local function publish_track(index, force)
  local tracks = rawget(_G, 'track')
  local clips = rawget(_G, 'clip')
  local item = type(tracks) == 'table' and tracks[index] or nil
  local clip_index = integer(item and item.clip, index)
  local clip_item = type(clips) == 'table' and clips[clip_index] or nil
  local values = {
    index,
    flag(item and item.play),
    flag(item and item.rec),
    flag(item and item.loop),
    integer(item and item.loop_start, 0),
    integer(item and item.loop_end, 16),
    clip_index,
    integer(item and item.pos_grid, -1),
    integer(item and item.speed, 0),
    flag(item and item.rev),
    flag(item and item.tempo_map),
    number(item and item.vol, 1),
    number(item and item.rec_level, 1),
    number(item and item.pre_level, 0),
    short_text(clip_item and clip_item.name or '-', 256),
    number(clip_item and clip_item.l, 0),
    number(clip_item and clip_item.bpm, 0),
  }
  publish_if_changed('track:' .. index, '/ingenue/mlr/track', values, force)
end

local function publish_pattern(index, force)
  local patterns = rawget(_G, 'pattern')
  local item = type(patterns) == 'table' and patterns[index] or nil
  local values = {
    index,
    flag(item and item.rec),
    flag(item and item.play),
    integer(item and item.count, 0),
  }
  publish_if_changed('pattern:' .. index, '/ingenue/mlr/pattern', values, force)
end

local function publish_recall(index, force)
  local recalls = rawget(_G, 'recall')
  local item = type(recalls) == 'table' and recalls[index] or nil
  local events = item and item.event
  local values = {
    index,
    flag(item and item.recording),
    flag(item and item.has_data),
    flag(item and item.active),
    type(events) == 'table' and #events or 0,
  }
  publish_if_changed('recall:' .. index, '/ingenue/mlr/recall', values, force)
end

local function publish_all(force)
  if not M.active then return end
  publish_meta(force)
  for index = 1, 7 do publish_clip(index, force) end
  for index = 1, 6 do publish_track(index, force) end
  for index = 1, 4 do
    publish_pattern(index, force)
    publish_recall(index, force)
  end
end

local function stop_timer()
  if M.timer then
    M.timer:stop()
    M.timer = nil
  end
end

local function reset()
  stop_timer()
  M.active = false
  M.signatures = {}
  send('/ingenue/mlr/reset', {})
end

local function pre_init()
  read_state_port()
  reset()
end

local function post_init()
  if not is_mlr() then return end
  M.active = true
  M.signatures = {}
  publish_all(true)
  M.timer = metro.init(function()
    if not is_mlr() then
      reset()
      return
    end
    publish_all(false)
  end, 0.05, -1)
  M.timer:start()
end

local function post_cleanup()
  reset()
end

mods.hook.register('script_pre_init', 'ingenue mlr observer pre-init', pre_init)
mods.hook.register('script_post_init', 'ingenue mlr observer post-init', post_init)
mods.hook.register('script_post_cleanup', 'ingenue mlr observer cleanup', post_cleanup)

return M
