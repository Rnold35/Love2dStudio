function love.conf(t)
  t.identity = "__PROJECT_SLUG__"
  t.version = "11.5"
  t.console = false
  t.window.title = "__PROJECT_NAME__"
  t.window.width = __WINDOW_WIDTH__
  t.window.height = __WINDOW_HEIGHT__
  t.window.minwidth = 640
  t.window.minheight = 400
  t.window.resizable = true
  t.window.vsync = 1
  t.window.highdpi = true
  t.modules.physics = false
  t.modules.video = false
end
