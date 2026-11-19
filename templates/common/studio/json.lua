-- Minimal JSON decoder for Love2D scene files.
-- Supports objects, arrays, strings (including \u escapes), numbers,
-- booleans, and null. This is intentionally tiny and has no dependencies.

local json = {}

local escapes = {
  ['"'] = '"',
  ["\\"] = "\\",
  ["/"] = "/",
  ["b"] = "\b",
  ["f"] = "\f",
  ["n"] = "\n",
  ["r"] = "\r",
  ["t"] = "\t"
}

local function utf8Char(code)
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(
      0xC0 + math.floor(code / 0x40),
      0x80 + (code % 0x40)
    )
  elseif code < 0x10000 then
    return string.char(
      0xE0 + math.floor(code / 0x1000),
      0x80 + (math.floor(code / 0x40) % 0x40),
      0x80 + (code % 0x40)
    )
  end
  return string.char(
    0xF0 + math.floor(code / 0x40000),
    0x80 + (math.floor(code / 0x1000) % 0x40),
    0x80 + (math.floor(code / 0x40) % 0x40),
    0x80 + (code % 0x40)
  )
end

local function decodeString(text, pos)
  pos = pos + 1
  local chunks = {}
  while pos <= #text do
    local char = text:sub(pos, pos)
    if char == '"' then
      return table.concat(chunks), pos + 1
    elseif char == "\\" then
      local escape = text:sub(pos + 1, pos + 1)
      if escape == "u" then
        local hex = text:sub(pos + 2, pos + 5)
        if not hex:match("^%x%x%x%x$") then
          error("invalid unicode escape at byte " .. pos, 0)
        end
        local code = tonumber(hex, 16)
        pos = pos + 6
        if code >= 0xD800 and code <= 0xDBFF then
          local lowHex = text:sub(pos + 2, pos + 5)
          local lowMarker = text:sub(pos, pos + 1)
          if lowMarker == "\\u" and lowHex:match("^%x%x%x%x$") then
            local low = tonumber(lowHex, 16)
            if low >= 0xDC00 and low <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
              pos = pos + 6
            end
          end
        end
        chunks[#chunks + 1] = utf8Char(code)
      else
        local replacement = escapes[escape]
        if not replacement then
          error("invalid escape at byte " .. pos, 0)
        end
        chunks[#chunks + 1] = replacement
        pos = pos + 2
      end
    else
      local nextEscape = text:find('[\\"]', pos)
      if not nextEscape then
        error("unterminated string at byte " .. pos, 0)
      end
      chunks[#chunks + 1] = text:sub(pos, nextEscape - 1)
      pos = nextEscape
    end
  end
  error("unterminated string at byte " .. pos, 0)
end

local function skipWhitespace(text, pos)
  local _, last = text:find("^[ \t\r\n]*", pos)
  return (last or pos - 1) + 1
end

local decodeValue

local function decodeArray(text, pos)
  local array = {}
  pos = skipWhitespace(text, pos + 1)
  if text:sub(pos, pos) == "]" then
    return array, pos + 1
  end
  while true do
    local value
    value, pos = decodeValue(text, pos)
    array[#array + 1] = value
    pos = skipWhitespace(text, pos)
    local char = text:sub(pos, pos)
    if char == "]" then
      return array, pos + 1
    elseif char ~= "," then
      error("expected ',' or ']' at byte " .. pos, 0)
    end
    pos = skipWhitespace(text, pos + 1)
  end
end

local function decodeObject(text, pos)
  local object = {}
  pos = skipWhitespace(text, pos + 1)
  if text:sub(pos, pos) == "}" then
    return object, pos + 1
  end
  while true do
    if text:sub(pos, pos) ~= '"' then
      error("expected string key at byte " .. pos, 0)
    end
    local key
    key, pos = decodeString(text, pos)
    pos = skipWhitespace(text, pos)
    if text:sub(pos, pos) ~= ":" then
      error("expected ':' at byte " .. pos, 0)
    end
    local value
    value, pos = decodeValue(text, skipWhitespace(text, pos + 1))
    object[key] = value
    pos = skipWhitespace(text, pos)
    local char = text:sub(pos, pos)
    if char == "}" then
      return object, pos + 1
    elseif char ~= "," then
      error("expected ',' or '}' at byte " .. pos, 0)
    end
    pos = skipWhitespace(text, pos + 1)
  end
end

decodeValue = function(text, pos)
  pos = skipWhitespace(text, pos)
  local char = text:sub(pos, pos)
  if char == "{" then
    return decodeObject(text, pos)
  elseif char == "[" then
    return decodeArray(text, pos)
  elseif char == '"' then
    return decodeString(text, pos)
  elseif text:sub(pos, pos + 3) == "true" then
    return true, pos + 4
  elseif text:sub(pos, pos + 4) == "false" then
    return false, pos + 5
  elseif text:sub(pos, pos + 3) == "null" then
    return nil, pos + 4
  else
    local number = text:sub(pos):match("^-?%d+%.?%d*[eE]?[+-]?%d*")
    if number and #number > 0 then
      local value = tonumber(number)
      if value == nil then
        error("invalid number at byte " .. pos, 0)
      end
      return value, pos + #number
    end
    error("unexpected token at byte " .. pos, 0)
  end
end

function json.decode(text)
  if type(text) ~= "string" then
    error("json.decode expects a string", 2)
  end
  local value, pos = decodeValue(text, 1)
  pos = skipWhitespace(text, pos)
  if pos <= #text then
    error("unexpected trailing data at byte " .. pos, 0)
  end
  return value
end

return json
