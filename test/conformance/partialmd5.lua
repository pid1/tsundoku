-- Transcription of KOReader frontend/util.lua partialMD5, emitting the sampled
-- bytes so they can be hashed outside Lua. `variant` picks the first offset:
--   "luajit"     -- lshift(1024, -2) as LuaJIT evaluates it (5-bit mask) => 0
--   "arithmetic" -- 1024 >> 2 read arithmetically => 256
local bit = require("bit")
local lshift = bit.lshift
local path, variant = arg[1], arg[2] or "luajit"
local step, size = 1024, 1024
local file = assert(io.open(path, "rb"))
local out = io.stdout
for i = -1, 10 do
  local offset
  if i == -1 and variant == "arithmetic" then
    offset = 256
  else
    offset = lshift(step, 2 * i)
  end
  file:seek("set", offset)
  local sample = file:read(size)
  if sample then out:write(sample) else break end
end
file:close()
