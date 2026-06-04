-- ingenue
-- modern web editor for norns
--
-- a responsive redesign of maiden that
-- runs alongside it on :7777.
--
-- install from maiden:
--   ;install https://github.com/seajaysec/ingenue
-- then SELECT > ingenue and run this once.
-- it stands up an always-on service and
-- shows you the URL to open in any browser.

local WEB = _path.code .. "ingenue/web"
local PORT = 7777
local state, ip = "starting…", "?"

local function sh(cmd)
  local f = io.popen(cmd); if not f then return "" end
  local r = f:read("*a"); f:close(); return r or ""
end

local function get_ip()
  local r = sh("hostname -I 2>/dev/null; ip route get 1 2>/dev/null")
  return r:match("(%d+%.%d+%.%d+%.%d+)") or "your-norns-ip"
end

local function has(cmd) return sh("command -v "..cmd.." 2>/dev/null") ~= "" end

local function install_service()
  if not util.file_exists(WEB .. "/server.py") then
    state = "error: server.py not found"; return
  end
  if has("systemctl") then
    local unit = "/tmp/ingenue.service"
    local f = io.open(unit, "w")
    f:write("[Unit]\nDescription=ingenue web editor for norns\nAfter=network.target\n")
    f:write("[Service]\nType=simple\nWorkingDirectory="..WEB.."\n")
    f:write("ExecStart=/usr/bin/python3 server.py "..PORT.."\nRestart=always\nRestartSec=3\n")
    f:write("[Install]\nWantedBy=multi-user.target\n")
    f:close()
    -- try with sudo (standard norns), then without (already root, e.g. some ports)
    os.execute("(sudo -n cp "..unit.." /etc/systemd/system/ || cp "..unit.." /etc/systemd/system/) 2>/dev/null")
    os.execute("(sudo -n systemctl daemon-reload || systemctl daemon-reload) 2>/dev/null")
    os.execute("(sudo -n systemctl enable --now ingenue || systemctl enable --now ingenue) 2>/dev/null")
    os.execute("(sudo -n systemctl restart ingenue || systemctl restart ingenue) 2>/dev/null")
    state = "installed · always on"
  else
    os.execute("pkill -f 'server.py "..PORT.."' 2>/dev/null; (cd "..WEB.." && setsid python3 server.py "..PORT.." >server.log 2>&1 &)")
    state = "running (add to boot for persistence)"
  end
end

function init()
  ip = get_ip()
  install_service()
  redraw()
end

function redraw()
  screen.clear()
  screen.level(15); screen.move(64, 18); screen.font_size(8); screen.text_center("ingenue")
  screen.level(3);  screen.move(64, 30); screen.text_center("web editor for norns")
  screen.level(15); screen.move(64, 46); screen.text_center("http://"..ip..":"..PORT)
  screen.level(4);  screen.move(64, 58); screen.text_center(state)
  screen.update()
end

function key(n, z) end
function enc(n, d) end
function cleanup() end
