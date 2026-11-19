---@meta

---Lightweight fallback definitions for LÖVE 11.x.
---The full LuaCATS definitions are downloaded automatically when network access
---is available. This file covers the APIs most game code touches.
---@class love
love = {}

---@param major number
---@param minor number
---@param revision number
---@return boolean
function love.isVersionCompatible(major, minor, revision) end

---@return number major
---@return number minor
---@return number revision
---@return string codename
function love.getVersion() end

---@param filename string
---@return string
function love.getVersionString(filename) end

---@param func function
---@param ... any
function love.run(func, ...) end

---@class love.Conf
---@field identity string|nil
---@field window table|nil
---@field modules table|nil
---@field console boolean|nil
---@field accelerometerjoystick boolean|nil
---@field externalstorage boolean|nil
---@field gammacorrect boolean|nil
---@field audio table|nil

love.conf = function(t) end

---@param callback function
function love.errorhandler(callback) end

-- love.graphics -------------------------------------------------------------

---@class love.graphics
love.graphics = {}

---@param r number
---@param g number
---@param b number
---@param a number|nil
function love.graphics.setColor(r, g, b, a) end

---@return number r
---@return number g
---@return number b
---@return number a
function love.graphics.getColor() end

---@param width number
---@param height number
---@param settings table|nil
function love.graphics.setMode(width, height, settings) end

---@return number width
---@return number height
function love.graphics.getDimensions() end

---@return number width
---@return number height
function love.graphics.getWidth() end

---@return number width
---@return number height
function love.graphics.getHeight() end

---@param title string
function love.graphics.setTitle(title) end

---@param file string
---@param settings table|nil
---@return love.Image image
function love.graphics.newImage(file, settings) end

---@param path string
---@param size number
---@return love.Font font
function love.graphics.newFont(path, size) end

---@param font love.Font
function love.graphics.setFont(font) end

---@return love.Font
function love.graphics.getFont() end

---@param x number
---@param y number
---@param w number|nil
---@param h number|nil
function love.graphics.rectangle(mode, x, y, w, h) end

---@param mode string
---@param x number
---@param y number
---@param w number
---@param h number
---@param radius number
---@param segments number|nil
function love.graphics.rectangle(mode, x, y, w, h, radius, segments) end

---@param mode string
---@param x number
---@param y number
---@param radius number
---@param segments number|nil
function love.graphics.circle(mode, x, y, radius, segments) end

---@param mode string
---@param x1 number
---@param y1 number
---@param x2 number
---@param y2 number
---@param x3 number
---@param y3 number
function love.graphics.polygon(mode, x1, y1, x2, y2, x3, y3) end

---@param x number
---@param y number
---@param angle number|nil
---@param sx number|nil
---@param sy number|nil
---@param ox number|nil
---@param oy number|nil
---@param kx number|nil
---@param ky number|nil
function love.graphics.draw(drawable, x, y, angle, sx, sy, ox, oy, kx, ky) end

---@param text string
---@param x number
---@param y number
---@param angle number|nil
---@param sx number|nil
---@param sy number|nil
---@param ox number|nil
---@param oy number|nil
function love.graphics.print(text, x, y, angle, sx, sy, ox, oy) end

---@param text string
---@param x number
---@param y number
---@param limit number
---@param align string|nil
function love.graphics.printf(text, x, y, limit, align) end

---@param x number
---@param y number
function love.graphics.translate(x, y) end

---@param angle number
function love.graphics.rotate(angle) end

---@param sx number
---@param sy number|nil
function love.graphics.scale(sx, sy) end

function love.graphics.push() end

---@param stack string|nil
function love.graphics.pop(stack) end

---@param x number
---@param y number
---@param w number
---@param h number
function love.graphics.intersectScissor(x, y, w, h) end

function love.graphics.setScissor() end

---@param x number
---@param y number
---@param w number
---@param h number
function love.graphics.setScissor(x, y, w, h) end

function love.graphics.clear() end

---@param r number
---@param g number
---@param b number
---@param a number|nil
function love.graphics.clear(r, g, b, a) end

function love.graphics.present() end

function love.graphics.setBackgroundColor() end

---@param r number
---@param g number
---@param b number
---@param a number|nil
function love.graphics.setBackgroundColor(r, g, b, a) end

---@param filter string
---@param anisotropy number|nil
function love.graphics.setDefaultFilter(filter, anisotropy) end

---@param value boolean
function love.graphics.setLineStyle(value) end

---@param width number
function love.graphics.setLineWidth(width) end

---@param a number
---@param b number
---@param c number
---@param d number
---@param e number
---@param f number
---@param g number
---@param h number
---@param i number
function love.graphics.setColorMask(a, b, c, d, e, f, g, h, i) end

-- love.window ---------------------------------------------------------------

---@class love.window
love.window = {}

---@param width number
---@param height number
---@param flags table|nil
---@return boolean success
---@return string|nil message
function love.window.setMode(width, height, flags) end

---@param title string
---@param icon love.Image|nil
function love.window.setTitle(title, icon) end

---@param fullscreen boolean
function love.window.setFullscreen(fullscreen) end

---@return boolean fullscreen
function love.window.getFullscreen() end

---@return number width
---@return number height
function love.window.getMode() end

-- love.filesystem -----------------------------------------------------------

---@class love.filesystem
love.filesystem = {}

---@param path string
---@return string|nil content
---@return string|nil size
function love.filesystem.read(path) end

---@param path string
---@return string|nil content
---@return string|nil size
function love.filesystem.read(path, bytes) end

---@param path string
---@param data string
---@return boolean success
---@return string|nil message
function love.filesystem.write(path, data) end

---@param path string
---@return boolean success
function love.filesystem.remove(path) end

---@param path string
---@return boolean exists
---@return table|nil info
function love.filesystem.getInfo(path) end

---@param dir string|nil
---@return table files
function love.filesystem.getDirectoryItems(dir) end

---@param path string
---@param mode string|nil
---@return love.File|nil file
---@return string|nil error
function love.filesystem.openFile(path, mode) end

---@param path string
---@param func function
---@return function chunk
function love.filesystem.load(path, func) end

---@param name string
---@param module table
function love.filesystem.init(name, module) end

-- love.timer ----------------------------------------------------------------

---@class love.timer
love.timer = {}

---@return number dt
function love.timer.step() end

---@return number dt
function love.timer.getDelta() end

---@return number time
function love.timer.getTime() end

---@return number fps
function love.timer.getFPS() end

---@return number average
---@return number min
---@return number max
---@return number median
function love.timer.getAverageDelta() end

---@param seconds number
function love.timer.sleep(seconds) end

-- love.math ----------------------------------------------------------------

---@class love.math
love.math = {}

---@param seed number|nil
function love.math.setRandomSeed(seed) end

---@param min number|nil
---@param max number|nil
---@return number
function love.math.random(min, max) end

---@param min number
---@param max number
---@return number
function love.math.randomNormal(min, max) end

---@param x number
---@param min number
---@param max number
---@return number
function love.math.clamp(x, min, max) end

---@param x number
---@param y number
---@param z number|nil
---@return number
function love.math.noise(x, y, z) end

---@param x number
---@return number
function love.math.sin(x) end

---@param x number
---@return number
function love.math.cos(x) end

-- love.keyboard -------------------------------------------------------------

---@class love.keyboard
love.keyboard = {}

---@param key string
---@return boolean pressed
function love.keyboard.isDown(key) end

---@param scancode string
---@return boolean pressed
function love.keyboard.isScancodeDown(scancode) end

---@return string key
function love.keyboard.getKeyFromScancode(scancode) end

-- love.mouse ----------------------------------------------------------------

---@class love.mouse
love.mouse = {}

---@return number x
---@return number y
function love.mouse.getPosition() end

---@param index number|nil
---@return number x
---@return number y
function love.mouse.getX(index) end

---@param index number|nil
---@return number x
---@return number y
function love.mouse.getY(index) end

---@param button number
---@return boolean pressed
function love.mouse.isDown(button) end

---@param visible boolean
function love.mouse.setVisible(visible) end

---@param mode string
function love.mouse.setGrabbed(mode) end

-- love.audio ----------------------------------------------------------------

---@class love.audio
love.audio = {}

---@param filename string
---@param type string|nil
---@return love.Source source
function love.audio.newSource(filename, type) end

---@param source love.Source
function love.audio.play(source) end

---@param source love.Source
function love.audio.stop(source) end

---@param volume number
function love.audio.setVolume(volume) end

-- love.event ----------------------------------------------------------------

---@class love.event
love.event = {}

function love.event.quit() end

---@param exitstatus number|nil
function love.event.quit(exitstatus) end

function love.event.pump() end

---@return table|nil
function love.event.poll() end

function love.event.clear() end

-- Common drawable types -----------------------------------------------------

---@class love.Image
---@field type string|nil
---@param width number|nil
---@param height number|nil
---@return number width
---@return number height
function love.Image:getDimensions(width, height) end

---@param width number
---@param height number
function love.Image:getWidth(width, height) end

---@return number width
function love.Image:getHeight() end

---@param filter string
---@param anisotropy number|nil
function love.Image:setFilter(filter, anisotropy) end

---@class love.Font
---@param text string
---@return number width
---@return number height
---@return table glyphs
function love.Font:getWrap(text, wraplimit) end

---@param text string
---@return number width
function love.Font:getWidth(text) end

---@param text string
---@return number height
function love.Font:getHeight(text) end

---@param size number
function love.Font:setLineHeight(size) end

---@class love.Source
---@param source love.Source
---@param clone number|nil
---@return love.Source source
function love.Source:clone(source, clone) end

function love.Source:play() end

function love.Source:stop() end

function love.Source:pause() end

---@param volume number
function love.Source:setVolume(volume) end

---@return number volume
function love.Source:getVolume() end

---@param loop boolean
function love.Source:setLooping(loop) end

---@return boolean loop
function love.Source:isLooping() end

---@param pitch number
function love.Source:setPitch(pitch) end

---@return boolean playing
function love.Source:isPlaying() end

---@class love.File
---@param bytes number|nil
---@return string|nil data
function love.File:read(bytes) end

---@param data string
---@return boolean success
---@return string|nil error
function love.File:write(data) end

---@return boolean eof
function love.File:eof() end

---@return number position
function love.File:tell() end

function love.File:close() end

-- LÖVE callbacks ------------------------------------------------------------

function love.load() end

---@param dt number
function love.update(dt) end

function love.draw() end

---@param key string
---@param scancode string
---@param isrepeat boolean
function love.keypressed(key, scancode, isrepeat) end

---@param key string
---@param scancode string
function love.keyreleased(key, scancode) end

---@param x number
---@param y number
---@param button number
---@param istouch boolean
---@param presses number
function love.mousepressed(x, y, button, istouch, presses) end

---@param x number
---@param y number
---@param button number
---@param istouch boolean
---@param presses number
function love.mousereleased(x, y, button, istouch, presses) end

---@param x number
---@param y number
---@param dx number
---@param dy number
---@param istouch boolean
function love.mousemoved(x, y, dx, dy, istouch) end

---@param w number
---@param h number
function love.resize(w, h) end

---@param dt number
function love.run(dt) end
