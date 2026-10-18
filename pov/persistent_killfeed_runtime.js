const sharedPersistentKillfeed = createPersistentKillfeed(sharedKillfeedSettings, {
    findHud: function () { return findHudTraverse("HudDeathNotice"); },
    createPanel: function (type, parent, id) { return $.CreatePanel(type, parent, id); },
});
function updateSharedPersistentKillfeed() {
    const state = controller.GetDemoControllerState();
    try {
        sharedPersistentKillfeed.update(state, state ? currentPovXuid(state) : "");
    } catch (error) {
        sharedPersistentKillfeed.dispose();
        $.Msg("CS2I_HUD_ERROR:persistentKillfeed:" + String(error));
        return;
    }
    $.Schedule(0, updateSharedPersistentKillfeed);
}
$.Schedule(0, updateSharedPersistentKillfeed);
