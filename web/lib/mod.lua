-- Ingenue mod entrypoint. Keep the tested Grid adapter isolated byte-for-byte
-- and load MIDI normalization as a sibling module from this exact directory.
local source = debug.getinfo(1, 'S').source
local directory = source:sub(1, 1) == '@' and source:sub(2):match('(.*/)') or nil
assert(directory, 'ingenue mod directory unavailable')
package.path = directory .. '?.lua;' .. package.path
local grid_adapter = require 'ingenue_grid_mod'
require 'ingenue_midi'
return grid_adapter
