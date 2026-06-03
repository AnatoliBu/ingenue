-- ingenue — launches the ingenue web service alongside maiden, on any norns.
-- Enable in SYSTEM > MODS, then restart; it starts at boot from then on.
local mod = require 'core/mods'

local moddir = _path.code .. 'ingenue/'

mod.hook.register("system_post_startup", "ingenue", function()
  os.execute(
    "pkill -f 'ingenue/server.py' 2>/dev/null; " ..
    "(cd " .. moddir .. " && setsid python3 server.py 7777 " ..
    ">" .. moddir .. "server.log 2>&1 </dev/null &)"
  )
end)
