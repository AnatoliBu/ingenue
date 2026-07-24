-- Ingenue mod entrypoint. Keep device adapters isolated and load them from this exact directory.
local source = debug.getinfo(1, 'S').source
local directory = source:sub(1, 1) == '@' and source:sub(2):match('(.*/)') or nil
assert(directory, 'ingenue mod directory unavailable')
package.path = directory .. '?.lua;' .. package.path
local grid_adapter = require 'ingenue_grid_mod'
require 'ingenue_midi'
require 'ingenue_grid_hardening'
require 'ingenue_arc'
require 'ingenue_gamepad'
return grid_adapter
