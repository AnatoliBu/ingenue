-- Ingenue virtual gamepad bridge for the native norns gamepad callback API.
local mods = require 'core/mods'
local dispatcher = require 'ingenue_midi'

local M = {previous_sign={}}
local buttons = {
  A=true, B=true, X=true, Y=true, L1=true, R1=true, L2=true, R2=true,
  L3=true, R3=true, SELECT=true, START=true,
}
local analog_axes = {
  leftx=true, lefty=true, rightx=true, righty=true, triggerleft=true, triggerright=true,
}

local function strict_integer(value, label, low, high)
  if type(value) ~= 'number' or value ~= math.floor(value) then error(label .. ' must be an integer') end
  if value < low or value > high then error(label .. ' must be between ' .. low .. ' and ' .. high) end
  return value
end

local function strict_number(value, label, low, high)
  if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge then
    error(label .. ' must be finite')
  end
  if value < low or value > high then error(label .. ' must be between ' .. low .. ' and ' .. high) end
  return value
end

local function ensure_api()
  if not gamepad or type(gamepad.trigger_button) ~= 'function' or type(gamepad.trigger_axis) ~= 'function' then
    error('norns gamepad API unavailable')
  end
end

local function call_analog(axis, value, half_reso)
  if _menu and _menu.mode then
    if _menu.gamepad_analog then _menu.gamepad_analog(axis, value, half_reso) end
  elseif gamepad.analog then
    gamepad.analog(axis, value, half_reso)
  end
end

local function sign_for(axis, normalized)
  if axis == 'triggerleft' or axis == 'triggerright' then return normalized >= (2 / 3) and 1 or 0 end
  if normalized >= (2 / 3) then return 1 end
  if normalized <= (-2 / 3) then return -1 end
  return 0
end

local function apply_sign(axis, sign)
  if axis == 'triggerleft' or axis == 'triggerright' then
    if gamepad.register_analog_button_state then
      gamepad.register_analog_button_state(axis, sign == 1, false, false)
    end
  elseif gamepad.register_direction_state then
    gamepad.register_direction_state(axis, sign, false, false)
  end
  if M.previous_sign[axis] ~= sign then
    M.previous_sign[axis] = sign
    gamepad.trigger_axis(axis, sign)
  end
end

local function handle_button(args)
  local name = tostring(args[4] or ''):upper()
  if not buttons[name] then error('unsupported gamepad button') end
  local state = strict_integer(args[5], 'gamepad button state', 0, 1)
  if gamepad.register_button_state then gamepad.register_button_state(name, state == 1) end
  gamepad.trigger_button(name, state)
  return {'gamepad', 'button', name, state}
end

local function handle_dpad(args)
  local axis = tostring(args[4] or ''):upper()
  if axis ~= 'X' and axis ~= 'Y' then error('gamepad dpad axis must be X or Y') end
  local sign = strict_integer(args[5], 'gamepad dpad sign', -1, 1)
  local sensor_axis = axis == 'X' and 'dpadx' or 'dpady'
  if gamepad.register_direction_state then gamepad.register_direction_state(sensor_axis, sign, false, false) end
  gamepad.trigger_axis(sensor_axis, sign)
  gamepad.trigger_dpad(axis, sign)
  return {'gamepad', 'dpad', axis, sign}
end

local function handle_analog(args)
  local axis = tostring(args[4] or ''):lower()
  if not analog_axes[axis] then error('unsupported gamepad analog axis') end
  local trigger = axis == 'triggerleft' or axis == 'triggerright'
  local normalized = strict_number(args[5], 'gamepad analog value', trigger and 0 or -1, 1)
  local half_reso = trigger and 65535 or 32767
  local value = math.floor(normalized * half_reso)
  call_analog(axis, value, half_reso)
  apply_sign(axis, sign_for(axis, normalized))
  return {'gamepad', 'analog', axis, normalized}
end

local function handler(args, action)
  ensure_api()
  if action == 'button' then return handle_button(args) end
  if action == 'dpad' then return handle_dpad(args) end
  if action == 'analog' then return handle_analog(args) end
  error('unsupported gamepad command')
end

local function reset_state()
  if not gamepad then M.previous_sign = {}; return end
  for axis, sign in pairs(M.previous_sign) do
    if sign ~= 0 then
      if axis == 'triggerleft' or axis == 'triggerright' then
        if gamepad.register_analog_button_state then gamepad.register_analog_button_state(axis, false, false, false) end
      elseif gamepad.register_direction_state then
        gamepad.register_direction_state(axis, 0, false, false)
      end
    end
  end
  M.previous_sign = {}
end

dispatcher.register_handler('gamepad', handler)
mods.hook.register('script_pre_init', 'ingenue gamepad reset', reset_state)
mods.hook.register('script_post_cleanup', 'ingenue gamepad cleanup', reset_state)

return M
