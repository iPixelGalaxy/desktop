/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenMemoryPressureManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenMemoryPressureManager.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.testing.enabled", true],
      ["zen.tab-unloader.auto-enabled", true],
      ["zen.tab-unloader.timeout-minutes", 10],
      ["zen.tab-unloader.min-loaded-tabs-before-pressure", 1],
      ["zen.tab-unloader.max-unloads-per-cycle", 3],
      ["zen.tab-unloader.max-emergency-unloads-per-cycle", 2],
    ],
  });
  ZenMemoryPressureManager.init(window);
  registerCleanupFunction(() => {
    ZenMemoryPressureManager.resetForTesting();
  });
});

function markIdle(tab) {
  Object.defineProperty(tab, "lastAccessed", {
    configurable: true,
    value: Date.now() - 11 * 60 * 1000,
  });
}

async function openMemoryTestTab(name, workspaceId) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    `data:text/html,<title>${name}</title>`,
    true,
    { skipAnimation: true }
  );
  tab.setAttribute("zen-workspace-id", workspaceId);
  markIdle(tab);
  return tab;
}

add_task(async function test_idle_scan_unloads_inactive_workspace_tabs() {
  const activeWorkspace = await gZenWorkspaces.createAndSaveWorkspace(
    "Memory Active"
  );
  const inactiveWorkspace = await gZenWorkspaces.createAndSaveWorkspace(
    "Memory Inactive"
  );
  await gZenWorkspaces.changeWorkspace(activeWorkspace);

  const activeTab = await openMemoryTestTab("active", activeWorkspace.uuid);
  const inactiveTabs = [];
  for (let i = 0; i < 4; i++) {
    inactiveTabs.push(
      await openMemoryTestTab(`inactive-${i}`, inactiveWorkspace.uuid)
    );
  }
  gBrowser.selectedTab = activeTab;

  const result = await ZenMemoryPressureManager.runCycleForTesting("scan");
  Assert.equal(result.unloaded, 3, "Idle scans unload only up to the scan cap");
  ok(!activeTab.hasAttribute("pending"), "The selected tab remains loaded");
  Assert.equal(
    inactiveTabs.filter(tab => tab.hasAttribute("pending")).length,
    3,
    "Inactive workspace tabs are preferred for unloading"
  );

  for (const tab of [activeTab, ...inactiveTabs]) {
    BrowserTestUtils.removeTab(tab);
  }
  await gZenWorkspaces.removeWorkspace(inactiveWorkspace.uuid);
  await gZenWorkspaces.removeWorkspace(activeWorkspace.uuid);
});

add_task(async function test_protected_tabs_are_not_candidates() {
  const workspace = await gZenWorkspaces.createAndSaveWorkspace(
    "Memory Protected"
  );
  const otherWorkspace = await gZenWorkspaces.createAndSaveWorkspace(
    "Memory Protected Other"
  );
  await gZenWorkspaces.changeWorkspace(workspace);

  const regular = await openMemoryTestTab("regular", otherWorkspace.uuid);
  const selected = await openMemoryTestTab("selected", otherWorkspace.uuid);
  const pending = await openMemoryTestTab("pending", otherWorkspace.uuid);
  const essential = await openMemoryTestTab("essential", otherWorkspace.uuid);
  const sound = await openMemoryTestTab("sound", otherWorkspace.uuid);
  const pip = await openMemoryTestTab("pip", otherWorkspace.uuid);
  const sharing = await openMemoryTestTab("sharing", otherWorkspace.uuid);
  const zenMode = await openMemoryTestTab("zen-mode", otherWorkspace.uuid);

  pending.setAttribute("pending", "true");
  essential.setAttribute("zen-essential", "true");
  sound.setAttribute("soundplaying", "true");
  pip.setAttribute("pictureinpicture", "true");
  sharing.setAttribute("sharing", "true");
  zenMode.linkedBrowser.zenModeActive = true;
  gBrowser.selectedTab = selected;

  const candidates =
    ZenMemoryPressureManager.collectCandidatesForTesting(window).map(
      candidate => candidate.tab
    );
  ok(candidates.includes(regular), "The regular tab is eligible");
  for (const protectedTab of [
    selected,
    pending,
    essential,
    sound,
    pip,
    sharing,
    zenMode,
  ]) {
    ok(!candidates.includes(protectedTab), "Protected tab is not eligible");
  }

  zenMode.linkedBrowser.zenModeActive = false;
  for (const tab of [
    regular,
    selected,
    pending,
    essential,
    sound,
    pip,
    sharing,
    zenMode,
  ]) {
    BrowserTestUtils.removeTab(tab);
  }
  await gZenWorkspaces.removeWorkspace(otherWorkspace.uuid);
  await gZenWorkspaces.removeWorkspace(workspace.uuid);
});

add_task(async function test_emergency_cycle_uses_emergency_cap() {
  const workspace = await gZenWorkspaces.createAndSaveWorkspace(
    "Memory Emergency"
  );
  const otherWorkspace = await gZenWorkspaces.createAndSaveWorkspace(
    "Memory Emergency Other"
  );
  await gZenWorkspaces.changeWorkspace(workspace);

  const selectedTab = await openMemoryTestTab("selected", workspace.uuid);
  const inactiveTabs = [];
  for (let i = 0; i < 4; i++) {
    inactiveTabs.push(
      await openMemoryTestTab(`emergency-${i}`, otherWorkspace.uuid)
    );
  }
  gBrowser.selectedTab = selectedTab;

  const result =
    await ZenMemoryPressureManager.runCycleForTesting("memory-pressure");
  Assert.equal(result.unloaded, 2, "Emergency cycles use the emergency cap");
  Assert.equal(
    inactiveTabs.filter(tab => tab.hasAttribute("pending")).length,
    2,
    "Emergency cycles unload background candidates first"
  );

  for (const tab of [selectedTab, ...inactiveTabs]) {
    BrowserTestUtils.removeTab(tab);
  }
  await gZenWorkspaces.removeWorkspace(otherWorkspace.uuid);
  await gZenWorkspaces.removeWorkspace(workspace.uuid);
});

add_task(async function test_update_tabs_toolbar_coalesces_container_updates() {
  let calls = 0;
  const originalUpdateTabsContainers = gZenWorkspaces.updateTabsContainers;
  gZenWorkspaces.updateTabsContainers = function (...args) {
    calls++;
    return originalUpdateTabsContainers.apply(this, args);
  };
  registerCleanupFunction(() => {
    gZenWorkspaces.updateTabsContainers = originalUpdateTabsContainers;
  });

  gZenUIManager.updateTabsToolbar();
  gZenUIManager.updateTabsToolbar();
  gZenUIManager.updateTabsToolbar();
  await new Promise(resolve => setTimeout(resolve, 0));

  Assert.equal(calls, 1, "Repeated toolbar updates coalesce into one rebuild");
  gZenWorkspaces.updateTabsContainers = originalUpdateTabsContainers;
});
