// ==UserScript==
// @name         Deepbelt Inventory Exporter
// @namespace    https://deepbelt.com/
// @version      1.6.0
// @description  Copy Deepbelt inventory and researched skill levels as JSON.
// @match        https://staging.deepbelt.com/*
// @match        https://www.deepbelt.com/*
// @updateURL    https://raw.githubusercontent.com/caboosemdw/deepbelt-utility-script/main/deepbelt-utility-script.user.js
// @downloadURL  https://raw.githubusercontent.com/caboosemdw/deepbelt-utility-script/main/deepbelt-utility-script.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_setClipboard
// @author       caboosemdw
// ==/UserScript==

(function () {
  "use strict";
  /* global GM_setClipboard */

  const BUTTON_CLASS = "dbi-export-inventory-button";
  const STYLE_ID = "dbi-export-inventory-style";
  const ITEM_SELECTOR = ".item";

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${BUTTON_CLASS} {
        flex: 0 0 auto;
        margin: 0 8px;
        padding: 6px 10px;
        border: 1px solid #c58b27;
        border-radius: 3px;
        color: #f1b547;
        background: #17130d;
        font: 700 10px/1.2 "Barlow Condensed", "Arial Narrow", sans-serif;
        letter-spacing: .07em;
        text-transform: uppercase;
        white-space: nowrap;
        cursor: pointer;
      }
      .${BUTTON_CLASS}:hover {
        color: #ffd16e;
        border-color: #f0b43d;
        background: #2a2113;
      }
      .${BUTTON_CLASS}:focus-visible {
        outline: 2px solid #f0b43d;
        outline-offset: 2px;
      }
      .${BUTTON_CLASS}[data-busy="true"] {
        opacity: .7;
        cursor: wait;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function textOf(element) {
    return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function cargoDialogs() {
    const labelled = [...document.querySelectorAll('[role="dialog"][aria-label]')]
      .filter((dialog) => /cargo/i.test(dialog.getAttribute("aria-label") ?? ""));
    if (labelled.length) return labelled;

    return [...document.querySelectorAll('.window[role="dialog"]')].filter((dialog) => {
      return /cargo/i.test(textOf(dialog.querySelector("header .name, .titlebar .name")));
    });
  }

  function skillsDialogs() {
    return [...document.querySelectorAll('.window[role="dialog"], section[role="dialog"]')].filter((dialog) => {
      return /^skills?$/i.test(textOf(dialog.querySelector("header .name, .titlebar .name, [data-window-title]")));
    });
  }

  function skillSlug(name) {
    return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function skillLevel(row) {
    const label = row.querySelector(".pips[aria-label]")?.getAttribute("aria-label") || "";
    const match = label.match(/^Level\s+(\d+)\s+of\s+(\d+)$/i);
    return match ? { level: Number(match[1]), maxLevel: Number(match[2]) } : null;
  }

  function parseSkills(dialog) {
    const body = dialog.querySelector(".body") || dialog;
    const rows = [...body.querySelectorAll('li.srow[data-skill]')];
    if (rows.length === 0) throw new Error("No skill rows were found. Open the Skills window and make sure its skill lists are loaded.");

    const skills = rows.map((row) => {
      const skillName = textOf(row.querySelector(".name"));
      const levelData = skillLevel(row);
      if (!skillName || !levelData) throw new Error("Found skill rows, but could not read each name and .pips level label; no partial export was copied.");
      return {
        skillId: skillSlug(skillName),
        gameSkillId: row.getAttribute("data-skill"),
        skillName,
        level: levelData.level,
        maxLevel: levelData.maxLevel,
      };
    });
    const uniqueSkills = [...new Map(skills.map((skill) => [skill.skillId, skill])).values()];
    uniqueSkills.sort((left, right) => left.skillName.localeCompare(right.skillName));
    return {
      schema: "deepbelt-skill-export",
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      gameHost: window.location.host,
      source: "Skills window rendered DOM",
      skills: uniqueSkills,
      warnings: [],
    };
  }

  function currentCargoPane(dialog) {
    const panes = [...dialog.querySelectorAll(".cargo")].filter(isVisible);
    if (panes.length) return panes[panes.length - 1];
    return dialog.querySelector(".body") ?? dialog;
  }

  function currentView(dialog, pane) {
    const selectedTab = dialog.querySelector(
      '.tabs [aria-selected="true"], .tabs .active, .tabs .selected, [role="tab"][aria-selected="true"]',
    );
    const selectedText = textOf(selectedTab);
    if (selectedText) return normalizedViewName(selectedText);

    const classes = [...pane.classList];
    const known = ["hold", "all", "ships"].find((name) => classes.includes(name));
    return known ?? "current-view";
  }

  function normalizedViewName(value) {
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized === "hold" || normalized === "cargo hold") return "hold";
    if (/^hold\s*&\s*hangar$/.test(normalized)) return "hold-and-hangar";
    if (normalized === "all hangars" || normalized === "all") return "all-hangars";
    return normalized.replace(/\s+/g, "-");
  }

  function cargoTabs(dialog) {
    return [...dialog.querySelectorAll(
      '.tabs button, .tabs [role="tab"], .tabs [aria-controls], .tabs .tab, .tabs a',
    )].filter((element) => isVisible(element) && textOf(element));
  }

  function activeViewMatches(dialog, target, tab = null) {
    if (tab && (tab.getAttribute("aria-selected") === "true" || tab.classList.contains("active") || tab.classList.contains("selected"))) return true;
    const pane = currentCargoPane(dialog);
    const selected = currentView(dialog, pane);
    if (normalizedViewName(selected) === target) return true;
    const classes = [...pane.classList].map((name) => name.toLowerCase());
    return target === "all-hangars"
      ? classes.includes("all")
      : (target === "hold" || target === "hold-and-hangar") && classes.includes("hold");
  }

  async function activateTab(dialog, tab, target) {
    if (!activeViewMatches(dialog, target, tab)) {
      tab.click();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (activeViewMatches(dialog, target, tab)) {
          // Let the game's view finish rendering after its selected state changes.
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      throw new Error(`The Cargo tab did not switch to ${textOf(tab)} in time.`);
    }
  }

  function parseNumber(value) {
    if (!value) return null;
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseItem(row) {
    const displayName = textOf(row.querySelector(".itemname")) || textOf(row.querySelector(".name"));
    if (!displayName) return null;

    const badgeElement = row.querySelector(".badge");
    const badge = textOf(badgeElement);
    const detailText = textOf(row.querySelector(".detail"));
    const rowText = textOf(row);
    const bound = /\bBOUND\b/i.test(rowText);
    const used = /\bused\b/i.test(detailText) || bound;
    const durabilityMatch = detailText.match(/durability\s+([\d,]+)\s*\/\s*([\d,]+)/i);

    const record = {
      displayName,
      badge: badge || null,
      detailText: detailText || rowText,
      bound,
      usedModule: used,
      availableForCrafting: !used,
      quantity: null,
      displayedTotalVolume: null,
      volumeUnit: null,
      minedQuantity: null,
      durability: durabilityMatch
        ? { current: parseNumber(durabilityMatch[1]), maximum: parseNumber(durabilityMatch[2]) }
        : null,
    };

    if (used) return record;

    const quantityAndVolume = detailText.match(/^\s*([\d,]+(?:\.\d+)?)\s*[·•]\s*([\d,]+(?:\.\d+)?)\s*m(?:³|3)(?=\s|$|[^\w])/i);
    if (quantityAndVolume) {
      record.quantity = parseNumber(quantityAndVolume[1]);
      record.displayedTotalVolume = parseNumber(quantityAndVolume[2]);
      record.volumeUnit = "m³";
    } else {
      const quantityOnly = detailText.match(/^\s*([\d,]+(?:\.\d+)?)(?:\s*[·•]|\s|$)/);
      if (quantityOnly) record.quantity = parseNumber(quantityOnly[1]);
      const volumeOnly = detailText.match(/([\d,]+(?:\.\d+)?)\s*m(?:³|3)(?=\s|$|[^\w])/i);
      if (volumeOnly) {
        record.displayedTotalVolume = parseNumber(volumeOnly[1]);
        record.volumeUnit = "m³";
      }
    }

    const minedMatch = detailText.match(/([\d,]+(?:\.\d+)?)\s+mined\b/i);
    if (minedMatch) record.minedQuantity = parseNumber(minedMatch[1]);
    return record;
  }

  function parseDeclaredKinds(noteText) {
    const match = noteText.match(/\b([\d,]+)\s+kinds?\b/i);
    return match ? parseNumber(match[1]) : null;
  }

  function parseStation(station, view) {
    const title = textOf(station.querySelector(".head h2, h2, .head .name")) || "Unknown location";
    const note = textOf(station.querySelector(".head .note, .note"));
    const rows = [...station.querySelectorAll(ITEM_SELECTOR)].map(parseItem).filter(Boolean);
    const declaredKinds = parseDeclaredKinds(note);
    const stackCount = rows.filter((item) => !item.usedModule).length;
    return {
      locationType: "station",
      locationName: title,
      sourceView: view,
      declaredKinds,
      usedModuleCount: rows.filter((item) => item.usedModule).length,
      items: rows,
      completenessCheck: declaredKinds === null ? "not-available" : declaredKinds === stackCount ? "matches-declared-kinds" : "check-row-count",
    };
  }

  function parseCargoView(dialog) {
    const pane = currentCargoPane(dialog);
    const view = currentView(dialog, pane);
    const stationElements = [...pane.querySelectorAll(".station")].filter(isVisible);
    const locations = stationElements.length
      ? stationElements.map((station) => parseStation(station, view))
      : parseSingleLocation(dialog, pane, view);
    const warnings = [];

    locations.forEach((location) => {
      if (location.completenessCheck === "check-row-count") {
        warnings.push(`${location.locationName}: the number of inventory rows differs from the station's displayed kind count. Check whether all rows loaded before relying on this export.`);
      }
    });
    if (!locations.some((location) => location.items.length > 0)) {
      warnings.push("No inventory rows were found in the active Cargo view. Check that the Cargo popup is fully loaded and the page structure has not changed.");
    }

    const headerSub = textOf(dialog.querySelector("header .sub, .titlebar .sub"));
    return {
      schema: "deepbelt-inventory-export",
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      gameHost: window.location.host,
      source: "Cargo popup rendered DOM",
      sourceView: view,
      shipContext: headerSub || null,
      locations,
      warnings,
    };
  }

  function findCombinedSection(pane, sectionName) {
    const expression = new RegExp(`^${sectionName}\\s*[·•]\\s*`, "i");
    const headings = [...pane.querySelectorAll("*")]
      .filter((element) => expression.test(textOf(element)) && textOf(element).length < 100)
      .sort((left, right) => textOf(left).length - textOf(right).length);
    const heading = headings[0] ?? null;
    let container = heading;
    while (container && container !== pane && container.querySelectorAll(ITEM_SELECTOR).length === 0) {
      container = container.parentElement;
    }
    return { heading, container };
  }

  function parseShipHoldFromCombinedPane(dialog, includeCurrentHangar) {
    const pane = currentCargoPane(dialog);
    const { heading, container } = findCombinedSection(pane, "hold");
    const warnings = [];
    const locations = [];
    if (!heading) {
      warnings.push("The Hold & Hangar tab was available, but its ship-hold section could not be identified. All Hangars data was still captured if that tab was available.");
    } else {
      const headerSub = textOf(dialog.querySelector("header .sub, .titlebar .sub"));
      const rows = container && container !== pane
        ? [...container.querySelectorAll(ITEM_SELECTOR)].map(parseItem).filter(Boolean)
        : [];
      locations.push({
        locationType: "ship-hold",
        locationName: headerSub || textOf(heading).replace(/^hold\s*[·•]\s*/i, "Ship hold · "),
        sourceView: "hold",
        declaredKinds: null,
        usedModuleCount: rows.filter((item) => item.usedModule).length,
        items: rows,
        completenessCheck: "not-available",
      });
    }

    if (includeCurrentHangar) {
      const hangarSection = findCombinedSection(pane, "hangar");
      if (!hangarSection.heading) {
        warnings.push("The Hold & Hangar tab was available without an All Hangars tab, but its current hangar section could not be identified.");
      } else {
        const rows = hangarSection.container && hangarSection.container !== pane
          ? [...hangarSection.container.querySelectorAll(ITEM_SELECTOR)].map(parseItem).filter(Boolean)
          : [];
        const locationName = textOf(hangarSection.heading).replace(/^hangar\s*[·•]\s*/i, "").trim() || "Current hangar";
        locations.push({
          locationType: "station",
          locationName,
          sourceView: "current-hangar",
          declaredKinds: null,
          usedModuleCount: rows.filter((item) => item.usedModule).length,
          items: rows,
          completenessCheck: "not-available",
        });
      }
    }
    return {
      locations,
      warnings,
    };
  }

  async function parseBothCargoViews(dialog) {
    const availableTabs = cargoTabs(dialog);
    const holdTab = availableTabs.find((tab) => normalizedViewName(textOf(tab)) === "hold") ?? null;
    const combinedTab = availableTabs.find((tab) => normalizedViewName(textOf(tab)) === "hold-and-hangar") ?? null;
    const allHangarsTab = availableTabs.find((tab) => normalizedViewName(textOf(tab)) === "all-hangars") ?? null;
    const capturePlan = [];
    if (holdTab) capturePlan.push({ tab: holdTab, view: "hold" });
    else if (combinedTab) capturePlan.push({ tab: combinedTab, view: "hold-and-hangar" });
    if (allHangarsTab) capturePlan.push({ tab: allHangarsTab, view: "all-hangars" });
    if (capturePlan.length === 0) {
      const labels = availableTabs.map(textOf).join(", ") || "none detected";
      throw new Error(`No supported inventory tabs were found. Tabs detected: ${labels}.`);
    }

    const tablist = dialog.querySelector('.tabs[role="tablist"], [role="tablist"], .tabs');
    const originalTab = tablist?.querySelector(
      '[aria-selected="true"], .active, .selected, button, [role="tab"]',
    ) ?? null;
    const views = [];
    let restoreError = null;

    try {
      for (const target of capturePlan) {
        await activateTab(dialog, target.tab, target.view);
        const viewData = target.view === "hold-and-hangar"
          ? parseShipHoldFromCombinedPane(dialog, !allHangarsTab)
          : parseCargoView(dialog);
        const sourceView = target.view === "hold-and-hangar" ? "hold" : target.view;
        viewData.locations.forEach((location) => { location.sourceView = sourceView; });
        views.push({
          sourceView,
          capturedAt: new Date().toISOString(),
          shipContext: textOf(dialog.querySelector("header .sub, .titlebar .sub")) || null,
          locations: viewData.locations,
          warnings: viewData.warnings,
        });
      }
    } finally {
      if (originalTab?.isConnected) {
        originalTab.click();
        const originalLabel = normalizedViewName(textOf(originalTab));
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !activeViewMatches(dialog, originalLabel, originalTab)) {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        if (!activeViewMatches(dialog, originalLabel, originalTab)) {
          restoreError = new Error("The original Cargo tab could not be restored.");
        }
      }
    }

    if (restoreError) throw restoreError;
    const locations = views.flatMap((view) => view.locations);
    const warnings = views.flatMap((view) => view.warnings.map((warning) => `${view.sourceView}: ${warning}`));
    if (!locations.some((location) => location.items.length > 0)) {
      warnings.push("No inventory rows were found in either Cargo view. Check that the Cargo popup is fully loaded and the page structure has not changed.");
    }
    return {
      schema: "deepbelt-inventory-export",
      schemaVersion: 2,
      capturedAt: new Date().toISOString(),
      gameHost: window.location.host,
      source: "Cargo popup rendered DOM",
      sourceView: views.map((view) => view.sourceView).join("+"),
      views,
      locations,
      warnings,
    };
  }

  function parseSingleLocation(dialog, pane, view) {
    const rows = [...pane.querySelectorAll(ITEM_SELECTOR)].map(parseItem).filter(Boolean);
    const headerSub = textOf(dialog.querySelector("header .sub, .titlebar .sub"));
    const isHold = /hold/i.test(view) || /in space|docked/i.test(headerSub);
    return [{
      locationType: isHold ? "ship-hold" : "cargo-view",
      locationName: isHold ? (headerSub || "Ship hold") : (headerSub || "Cargo view"),
      sourceView: view,
      declaredKinds: null,
      usedModuleCount: rows.filter((item) => item.usedModule).length,
      items: rows,
      completenessCheck: "not-available",
    }];
  }

  function copyJson(data) {
    if (typeof GM_setClipboard !== "function") {
      throw new Error("Tampermonkey clipboard access is unavailable. Reinstall the updated script and allow its clipboard permission.");
    }
    GM_setClipboard(JSON.stringify(data, null, 2), "text");
  }

  function setButtonMessage(button, message, original = "Copy Inventory") {
    button.textContent = message;
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 2800);
  }

  function installButton(dialog) {
    const header = dialog.querySelector("header.titlebar, header");
    if (!header || header.querySelector(`.${BUTTON_CLASS}`)) return;
    const sub = header.querySelector(":scope > .sub");
    const tools = header.querySelector(":scope > .tools");
    if (!sub || !tools) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "Copy Inventory";
    button.title = "Copy inventory from Hold and All Hangars as JSON for pasting into the shipbuilder";
    button.setAttribute("aria-label", "Copy inventory from Hold and All Hangars");
    button.addEventListener("click", async () => {
      if (button.dataset.busy === "true") return;
      button.dataset.busy = "true";
      button.textContent = "Exporting…";
      try {
        const data = await parseBothCargoViews(dialog);
        const count = data.locations.reduce((sum, location) => sum + location.items.length, 0);
        if (count === 0) {
          setButtonMessage(button, "No rows found");
          console.warn("[Deepbelt Inventory Exporter]", data.warnings);
          return;
        }
        copyJson(data);
        setButtonMessage(button, `Copied ${count} rows · both views`);
        if (data.warnings.length) console.warn("[Deepbelt Inventory Exporter] Review this export:", data.warnings);
      } catch (error) {
        console.error("[Deepbelt Inventory Exporter] Export failed:", error);
        setButtonMessage(button, "Export failed");
      } finally {
        delete button.dataset.busy;
      }
    });

    header.insertBefore(button, tools);
  }

  function installSkillsButton(dialog) {
    const header = dialog.querySelector("header.titlebar, header");
    if (!header || header.querySelector(`.${BUTTON_CLASS}`)) return;
    const sub = header.querySelector(":scope > .sub");
    const tools = header.querySelector(":scope > .tools");
    if (!sub || !tools) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "Copy Skills";
    button.title = "Copy researched skill levels as JSON for the shipbuilder";
    button.setAttribute("aria-label", "Copy researched skill levels");
    button.addEventListener("click", () => {
      if (button.dataset.busy === "true") return;
      button.dataset.busy = "true";
      button.textContent = "Exporting…";
      try {
        const data = parseSkills(dialog);
        copyJson(data);
        setButtonMessage(button, `Copied ${data.skills.length} skills`, "Copy Skills");
      } catch (error) {
        console.error("[Deepbelt Inventory Exporter] Skill export failed:", error);
        setButtonMessage(button, "Export failed", "Copy Skills");
      } finally {
        delete button.dataset.busy;
      }
    });
    header.insertBefore(button, tools);
  }

  function scan() {
    installStyles();
    cargoDialogs().forEach(installButton);
    skillsDialogs().forEach(installSkillsButton);
  }

  scan();
  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
