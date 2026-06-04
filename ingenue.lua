-- ingenue
-- modern web editor for norns
--
-- a responsive redesign of maiden that
-- runs alongside it on :7777.
--
-- install from maiden:
--   ;install https://github.com/seajaysec/ingenue
-- then SELECT > ingenue and run this once.
-- it ensures python is present, stands up
-- an always-on service, and shows you the
-- URL to open in any browser.

local PORT = 7777
local DIR = _path.code .. "ingenue"
local state, ip = "starting…", "?"

local function sh(cmd)
  local f = io.popen(cmd); if not f then return "" end
  local r = f:read("*a"); f:close(); return r or ""
end

local function get_ip()
  local r = sh("hostname -I 2>/dev/null; ip route get 1 2>/dev/null")
  return r:match("(%d+%.%d+%.%d+%.%d+)") or "your-norns-ip"
end

local function run_installer()
  local script = DIR .. "/install.sh"
  if not util.file_exists(script) then state = "error: install.sh missing"; return end
  -- reuse the unified installer: files are already here (NO_FETCH); it ensures python3
  -- (installing it if the OS lacks it) and sets up the persistent service.
  local cmd = string.format(
    "INGENUE_NO_FETCH=1 INGENUE_DUST=%q INGENUE_PORT=%d bash %q >/tmp/ingenue-install.log 2>&1",
    _path.dust, PORT, script)
  local rc = os.execute(cmd)
  if rc == true or rc == 0 then state = "installed · always on :" .. PORT
  else state = "see /tmp/ingenue-install.log" end
end

function init()
  ip = get_ip()
  state = "installing… (a minute the first time)"
  redraw()
  run_installer()
  redraw()
end

function redraw()
  screen.clear()
  screen.level(15); screen.move(64, 18); screen.font_size(8); screen.text_center("ingenue")
  screen.level(3);  screen.move(64, 30); screen.text_center("web editor for norns")
  screen.level(15); screen.move(64, 46); screen.text_center("http://" .. ip .. ":" .. PORT)
  screen.level(4);  screen.move(64, 58); screen.text_center(state)
  screen.update()
end

function key(n, z) end
function enc(n, d) end
function cleanup() end
