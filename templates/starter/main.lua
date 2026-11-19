-- Love2D Studio — Starter template
-- Edit this file in Zed, design levels in the Studio, and ask the Love2D
-- Assistant for help. The scene file is hot-reloaded with R while the game runs.

require("studio.log").install()

local Scene = require("studio.scene")

local scene
local player
local message = ""
local messageTimer = 0

local GRAVITY = 1650
local MOVE_SPEED = 235
local JUMP_SPEED = 545

local function reloadScene()
  local ok, result = pcall(Scene.load, "main")
  if ok then
    scene = result
    message = "Scene reloaded"
    messageTimer = 1.4
  else
    message = tostring(result)
    messageTimer = 4
    print("[main] " .. message)
  end
end

local function resetPlayer()
  player = {
    x = 64,
    y = 360,
    w = 28,
    h = 38,
    vx = 0,
    vy = 0,
    grounded = false,
    coyote = 0,
    jumpBuffer = 0
  }
end

local function solidBlocks()
  local blocks = {}
  if not scene then return blocks end
  for _, entity in ipairs(scene.entities) do
    if (entity.type == "rectangle" or entity.type == "rect")
      and not entity.hidden
      and entity.properties
      and entity.properties.solid then
      blocks[#blocks + 1] = entity
    end
  end
  return blocks
end

local function overlaps(a, b)
  return a.x < b.x + (b.w or 0)
    and a.x + a.w > b.x
    and a.y < b.y + (b.h or 0)
    and a.y + a.h > b.y
end

local function movePlayer(dt)
  local left = love.keyboard.isDown("a", "left")
  local right = love.keyboard.isDown("d", "right")
  local direction = (right and 1 or 0) - (left and 1 or 0)
  local target = direction * MOVE_SPEED
  local acceleration = player.grounded and 1800 or 900
  player.vx = player.vx + (target - player.vx) * math.min(1, acceleration * dt / MOVE_SPEED)

  player.jumpBuffer = math.max(0, player.jumpBuffer - dt)
  player.coyote = player.grounded and 0.1 or math.max(0, player.coyote - dt)
  if player.jumpBuffer > 0 and player.coyote > 0 then
    player.vy = -JUMP_SPEED
    player.grounded = false
    player.coyote = 0
    player.jumpBuffer = 0
  end

  player.vy = player.vy + GRAVITY * dt
  if love.keyboard.isDown("space", "up", "w") and player.vy < -120 then
    player.vy = player.vy + GRAVITY * 0.55 * dt
  end

  local blocks = solidBlocks()

  player.x = player.x + player.vx * dt
  for _, block in ipairs(blocks) do
    if overlaps(player, block) then
      if player.vx > 0 then
        player.x = block.x - player.w
      elseif player.vx < 0 then
        player.x = block.x + (block.w or 0)
      end
      player.vx = 0
    end
  end

  player.y = player.y + player.vy * dt
  player.grounded = false
  for _, block in ipairs(blocks) do
    if overlaps(player, block) then
      if player.vy > 0 then
        player.y = block.y - player.h
        player.vy = 0
        player.grounded = true
      elseif player.vy < 0 then
        player.y = block.y + (block.h or 0)
        player.vy = 0
      end
    end
  end

  local boundsWidth = scene and scene.width or love.graphics.getWidth()
  local boundsHeight = scene and scene.height or love.graphics.getHeight()
  player.x = math.max(0, math.min(boundsWidth - player.w, player.x))
  if player.y > boundsHeight + 240 then
    resetPlayer()
    message = "Respawned"
    messageTimer = 1
  end
end

function love.load()
  love.graphics.setDefaultFilter("nearest", "nearest")
  love.window.setTitle("__PROJECT_NAME__")
  love.graphics.setBackgroundColor(0.055, 0.065, 0.085)
  reloadScene()
  resetPlayer()
  print(string.format(
    "[Love2D Studio] Game ready — %s (%d entities)",
    scene and scene.name or "no scene",
    scene and #scene.entities or 0
  ))
end

function love.update(dt)
  if not scene then return end
  movePlayer(dt)
  messageTimer = math.max(0, messageTimer - dt)
end

function love.draw()
  if scene then
    scene:drawBackground()
    scene:draw()
  else
    love.graphics.clear(0.08, 0.045, 0.06)
    love.graphics.setColor(1, 0.4, 0.55)
    love.graphics.print("No scene loaded", 24, 24)
  end

  -- The player is game code, not a scene entity.
  love.graphics.setColor(1, 0.36, 0.54, 1)
  love.graphics.rectangle("fill", player.x, player.y, player.w, player.h, 5, 5)
  love.graphics.setColor(1, 0.8, 0.88, 1)
  love.graphics.rectangle("fill", player.x + 6, player.y + 8, 5, 7, 2, 2)
  love.graphics.rectangle("fill", player.x + 17, player.y + 8, 5, 7, 2, 2)

  love.graphics.setFont(love.graphics.newFont(14))
  love.graphics.setColor(1, 1, 1, 0.72)
  love.graphics.print("A/D or arrows  •  Space to jump  •  R reload scene  •  F11 fullscreen", 16, 14)

  if messageTimer > 0 then
    love.graphics.setColor(0.05, 0.06, 0.08, 0.88)
    love.graphics.rectangle("fill", 16, love.graphics.getHeight() - 58, math.min(720, love.graphics.getWidth() - 32), 40, 8, 8)
    love.graphics.setColor(1, 0.52, 0.66)
    love.graphics.print(message, 28, love.graphics.getHeight() - 46)
  end
end

function love.keypressed(key)
  if key == "escape" then
    love.event.quit()
  elseif key == "r" then
    reloadScene()
    resetPlayer()
  elseif key == "f11" then
    love.window.setFullscreen(not love.window.getFullscreen())
  elseif key == "space" or key == "up" or key == "w" then
    player.jumpBuffer = 0.13
  end
end

function love.resize()
  -- The level is fixed-size; F11 scales the window but the scene stays 960x600.
end
