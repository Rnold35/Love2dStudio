-- Love2D Studio console bridge.
-- The companion Studio sets LOVE2D_STUDIO_LOG to a file path before launching
-- the game and tails that file, so print() and uncaught errors show up in the
-- live console even when Windows does not pipe LÖVE's stdout.
--
-- Add this at the very top of main.lua if you are adopting an existing project:
--   require("studio.log").install()

local Log = {}
local installed = false

local function timestamp()
  return os.date("%H:%M:%S")
end

local function logPath()
  local fromEnv = os.getenv("LOVE2D_STUDIO_LOG")
  if fromEnv and fromEnv ~= "" then
    return fromEnv
  end
  local ok, source = pcall(function()
    return love.filesystem.getSource()
  end)
  if ok and source and source ~= "" then
    return source .. "/.love2d-studio/runtime/game.log"
  end
  return nil
end

local function writeLine(text)
  local path = logPath()
  if not path then return false end
  local file = io.open(path, "a")
  if not file then return false end
  file:write(timestamp(), " ", tostring(text), "\n")
  file:close()
  return true
end

local function formatArgs(...)
  local parts = {}
  for index = 1, select("#", ...) do
    parts[#parts + 1] = tostring(select(index, ...))
  end
  return table.concat(parts, "\t")
end

function Log.install()
  if installed then return Log end
  installed = true

  local usingFile = writeLine("Love2D Studio console attached")
  if not usingFile then
    return Log
  end

  local originalPrint = print
  print = function(...)
    local text = formatArgs(...)
    writeLine(text)
    if os.getenv("LOVE2D_STUDIO_LOG") == nil then
      originalPrint(text)
    end
  end

  local originalErrorHandler = love.errorhandler
  if originalErrorHandler then
    love.errorhandler = function(message, ...)
      writeLine("ERROR: " .. tostring(message))
      local trace = debug and debug.traceback and debug.traceback("", 2) or nil
      if trace then writeLine(trace) end
      return originalErrorHandler(message, ...)
    end
  end

  return Log
end

function Log.write(...)
  writeLine(formatArgs(...))
end

return Log
