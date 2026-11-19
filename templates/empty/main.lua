-- Love2D Studio — Empty template
-- This is a clean LÖVE project. Open the Studio from Zed's task menu to
-- design scenes, and use the Love2D Assistant for code help.

require("studio.log").install()

function love.load()
  love.window.setTitle("__PROJECT_NAME__")
  love.graphics.setBackgroundColor(0.055, 0.065, 0.085)
  print("[Love2D Studio] Game ready")
end

function love.update(dt)
end

function love.draw()
  love.graphics.setColor(1, 0.36, 0.54)
  love.graphics.setFont(love.graphics.newFont(38))
  love.graphics.print("Hello, LÖVE!", 48, 48)
  love.graphics.setColor(0.75, 0.8, 0.9)
  love.graphics.setFont(love.graphics.newFont(16))
  love.graphics.print("Edit main.lua in Zed, or open the Studio to design a scene.", 50, 108)
end

function love.keypressed(key)
  if key == "escape" then
    love.event.quit()
  end
end
