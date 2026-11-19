-- Love2D Studio scene runtime.
-- Scenes are plain JSON files in scenes/ and can be edited visually in the
-- companion Studio. Frame the API below from main.lua:
--
--   local Scene = require("studio.scene")
--   scene = Scene.load("main")   -- scenes/main.json
--   scene:draw()
--
-- Supported entity types: sprite, rectangle, circle, text.

local json = require("studio.json")

local Scene = {}
Scene.__index = Scene

local imageCache = {}
local fontCache = {}

local function getImage(path)
  if imageCache[path] == nil then
    local ok, image = pcall(love.graphics.newImage, path)
    imageCache[path] = ok and image or false
    if not ok then
      print("[studio.scene] Could not load image: " .. tostring(path))
    end
  end
  return imageCache[path] or nil
end

local function getFont(size)
  size = math.max(1, math.floor(tonumber(size) or 16))
  if not fontCache[size] then
    fontCache[size] = love.graphics.newFont(size)
  end
  return fontCache[size]
end

local function colorOf(entity, opacity)
  local color = entity.color or { 1, 1, 1, 1 }
  love.graphics.setColor(
    color[1] or 1,
    color[2] or 1,
    color[3] or 1,
    (color[4] == nil and 1 or color[4]) * (opacity or 1)
  )
end

local function entityAlpha(entity, scene)
  return (entity.opacity == nil and 1 or entity.opacity) * (scene.opacity == nil and 1 or scene.opacity)
end

local function drawSprite(entity, scene)
  local image = getImage(entity.path)
  local width = entity.w or (image and image:getWidth()) or 32
  local height = entity.h or (image and image:getHeight()) or 32
  colorOf(entity, entityAlpha(entity, scene))
  if not image then
    love.graphics.rectangle("line", entity.x, entity.y, width, height)
    return
  end
  local scaleX = width / image:getWidth()
  local scaleY = height / image:getHeight()
  love.graphics.draw(
    image,
    entity.x + width / 2,
    entity.y + height / 2,
    math.rad(entity.rotation or 0),
    scaleX,
    scaleY,
    image:getWidth() / 2,
    image:getHeight() / 2
  )
end

local function drawRectangle(entity, scene)
  local width = entity.w or 32
  local height = entity.h or 32
  colorOf(entity, entityAlpha(entity, scene))
  love.graphics.push()
  love.graphics.translate(entity.x + width / 2, entity.y + height / 2)
  love.graphics.rotate(math.rad(entity.rotation or 0))
  local mode = entity.fill == false and "line" or "fill"
  local radius = tonumber(entity.radius) or 0
  if radius > 0 then
    love.graphics.rectangle(mode, -width / 2, -height / 2, width, height, radius)
  else
    love.graphics.rectangle(mode, -width / 2, -height / 2, width, height)
  end
  love.graphics.pop()
end

local function drawCircle(entity, scene)
  local width = entity.w or 32
  local height = entity.h or width
  colorOf(entity, entityAlpha(entity, scene))
  love.graphics.push()
  love.graphics.translate(entity.x + width / 2, entity.y + height / 2)
  love.graphics.rotate(math.rad(entity.rotation or 0))
  love.graphics.ellipse(
    entity.fill == false and "line" or "fill",
    0,
    0,
    width / 2,
    height / 2
  )
  love.graphics.pop()
end

local function drawText(entity, scene)
  local width = entity.w or 300
  local font = getFont(entity.fontSize or 16)
  love.graphics.setFont(font)
  colorOf(entity, entityAlpha(entity, scene))
  love.graphics.push()
  love.graphics.translate(entity.x + width / 2, entity.y + (entity.h or font:getHeight()) / 2)
  love.graphics.rotate(math.rad(entity.rotation or 0))
  love.graphics.printf(
    entity.text or "",
    -width / 2,
    -(entity.h or font:getHeight()) / 2,
    width,
    entity.align or "left"
  )
  love.graphics.pop()
end

local drawFunctions = {
  sprite = drawSprite,
  rectangle = drawRectangle,
  rect = drawRectangle,
  circle = drawCircle,
  text = drawText
}

function Scene.load(name)
  if type(name) ~= "string" or name == "" then
    error("Scene.load expects a scene name or path", 2)
  end
  local path = name:gsub("\\", "/")
  if not path:find("/", 1, true) then
    path = "scenes/" .. path
  end
  if not path:match("%.json$") then
    path = path .. ".json"
  end
  local contents, message = love.filesystem.read(path)
  if not contents then
    error("Could not read " .. path .. ": " .. tostring(message), 2)
  end
  local ok, data = pcall(json.decode, contents)
  if not ok then
    error("Could not parse " .. path .. ": " .. tostring(data), 2)
  end
  if type(data) ~= "table" then
    error(path .. " did not contain a scene object", 2)
  end
  data.path = path
  data.name = data.name or path:match("([^/]+)%.json$") or "scene"
  data.entities = data.entities or {}
  return setmetatable(data, Scene)
end

function Scene:reload()
  local fresh = Scene.load(self.path)
  for key in pairs(self) do
    self[key] = nil
  end
  for key, value in pairs(fresh) do
    self[key] = value
  end
  return self
end

function Scene:drawBackground()
  local background = self.background or { 0.06, 0.07, 0.09, 1 }
  love.graphics.clear(
    background[1] or 0.06,
    background[2] or 0.07,
    background[3] or 0.09,
    background[4] == nil and 1 or background[4]
  )
end

function Scene:draw()
  local ordered = {}
  for index, entity in ipairs(self.entities) do
    ordered[index] = entity
  end
  table.sort(ordered, function(a, b)
    local layerA = a.layer or 0
    local layerB = b.layer or 0
    if layerA ~= layerB then
      return layerA < layerB
    end
    return (a.id or "") < (b.id or "")
  end)
  for _, entity in ipairs(ordered) do
    if entity.visible ~= false then
      local draw = drawFunctions[entity.type]
      if draw then
        draw(entity, self)
      end
    end
  end
  love.graphics.setColor(1, 1, 1, 1)
end

function Scene:get(idOrName)
  for _, entity in ipairs(self.entities) do
    if entity.id == idOrName or entity.name == idOrName then
      return entity
    end
  end
  return nil
end

function Scene:getByType(entityType)
  local found = {}
  for _, entity in ipairs(self.entities) do
    if entity.type == entityType then
      found[#found + 1] = entity
    end
  end
  return found
end

function Scene:getByTag(tag)
  local found = {}
  for _, entity in ipairs(self.entities) do
    local tags = entity.tags or {}
    for _, value in ipairs(tags) do
      if value == tag then
        found[#found + 1] = entity
        break
      end
    end
  end
  return found
end

function Scene:width()
  return self.width or love.graphics.getWidth()
end

function Scene:height()
  return self.height or love.graphics.getHeight()
end

return Scene
