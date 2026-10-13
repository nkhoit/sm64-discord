-- name: MKB Probe
-- description: Test mod for controls-lab.mjs: logs controller buttons/stick and camera yaw for bind tests.
local last = -1
local frames = 0
hook_event(HOOK_BEFORE_MARIO_UPDATE, function(m)
    if m.playerIndex ~= 0 then return end
    local c = m.controller
    frames = frames + 1
    local key = c.buttonDown * 65536 + (c.rawStickX + 128) * 256 + (c.rawStickY + 128)
    if key ~= last or frames % 30 == 0 then
        last = key
        print(string.format("MKB btn=%04x sx=%d sy=%d yaw=%d", c.buttonDown, c.rawStickX, c.rawStickY, m.area.camera.yaw))
    end
end)
