// client/src/ui.ts
// FULL FILE - No Omits, All Logic
// Contains DOM Setup, CSS styling, and Static UI Elements

export const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("Missing <div id='app'></div> in index.html");

document.addEventListener("contextmenu", (e) => e.preventDefault());

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";
document.body.style.overflow = "hidden";

appEl.style.position = "absolute";
appEl.style.top = "0";
appEl.style.bottom = "0";
appEl.style.left = "0";
appEl.style.right = "0";
appEl.style.zIndex = "1";

/* ===============================
   Class Selection UI
================================ */
export const classOverlay = document.createElement("div");
classOverlay.style.position = "fixed";
classOverlay.style.inset = "0";
classOverlay.style.background = "rgba(0, 10, 15, 0.9)";
classOverlay.style.zIndex = "500";
classOverlay.style.display = "none"; 
classOverlay.style.flexDirection = "column";
classOverlay.style.alignItems = "center";
classOverlay.style.justifyContent = "center";
classOverlay.style.color = "white";
classOverlay.style.fontFamily = "monospace";
document.body.appendChild(classOverlay);

export const classTitle = document.createElement("h1");
classTitle.textContent = "CHOOSE YOUR PATH";
classTitle.style.marginBottom = "30px";
classTitle.style.textShadow = "0 0 15px #00ffff";
classOverlay.appendChild(classTitle);

export const classGrid = document.createElement("div");
classGrid.style.display = "grid";
classGrid.style.gridTemplateColumns = "repeat(3, 1fr)";
classGrid.style.gap = "20px";
classGrid.style.maxWidth = "1100px";
classOverlay.appendChild(classGrid);

export const CLASSES = [
  { id: "VANGUARD", name: "The Vanguard", aura: "Iron Essence", desc: "Immovable object. Block hits and crush enemy poise.", perks: ["Juggernaut: +100 Max Poise, 75% Block mitigation", "Demolition: +15% damage to stone/ores"] },
  { id: "NIGHTBLADE", name: "The Nightblade", aura: "Shadow Essence", desc: "High-risk, high-reward evasion and critical strikes.", perks: ["Ghost Step: Extended dodge i-frames", "Lethal Momentum: +10% Crit Chance"] },
  { id: "BLOODRAGER", name: "The Bloodrager", aura: "Blood Essence", desc: "Berserker sustain. Trade health for aggressive lifesteal.", perks: ["Siphon: Melee hits restore 1 HP", "Adrenaline: Taking damage grants Aura regen"] },
  { id: "SPELLBLADE", name: "The Spellblade", aura: "Astral Essence", desc: "Ability spammer. Relies on skills over physical attacks.", perks: ["Deep Well: Double starting Max Mana & Aura", "Leyline: +50% Mana/Aura regen"] },
  { id: "PROSPECTOR", name: "The Prospector", aura: "Unattuned", desc: "Economy and builder class. Master of gathering.", perks: ["Expert Miner: -25% block break time", "Lucky Strike: 15% chance for double drops"] },
  { id: "WARDEN", name: "The Warden", aura: "Nature Essence", desc: "Support and sustain. Harness the earth to heal wounds.", perks: ["Photosynthesis: Passive HP regen", "Bountiful Harvest: Bonus medicinal drops from plants"] }
];

export let selectedClassId: string | null = null;
export const classCards: HTMLDivElement[] = [];

export const confirmBtn = document.createElement("button");
confirmBtn.textContent = "AWAKEN";
confirmBtn.style.marginTop = "40px";
confirmBtn.style.padding = "15px 40px";
confirmBtn.style.fontSize = "18px";
confirmBtn.style.fontWeight = "bold";
confirmBtn.style.fontFamily = "monospace";
confirmBtn.style.background = "rgba(0, 255, 255, 0.2)";
confirmBtn.style.color = "white";
confirmBtn.style.border = "2px solid #00ffff";
confirmBtn.style.borderRadius = "8px";
confirmBtn.style.cursor = "pointer";
confirmBtn.style.opacity = "0.3";
confirmBtn.style.pointerEvents = "none";
confirmBtn.style.transition = "all 0.2s ease";

CLASSES.forEach(cls => {
  const card = document.createElement("div");
  card.style.background = "rgba(255, 255, 255, 0.05)";
  card.style.border = "2px solid rgba(255, 255, 255, 0.1)";
  card.style.borderRadius = "10px";
  card.style.padding = "20px";
  card.style.cursor = "pointer";
  card.style.transition = "all 0.2s ease";
  
  card.innerHTML = `
    <h2 style="margin: 0 0 10px 0; color: #00ffff;">${cls.name}</h2>
    <div style="font-size: 12px; color: #aaa; margin-bottom: 10px;">Aura: ${cls.aura}</div>
    <div style="font-size: 14px; margin-bottom: 15px; min-height: 40px;">${cls.desc}</div>
    <ul style="font-size: 12px; color: #ddd; padding-left: 20px; margin: 0;">
      ${cls.perks.map(p => `<li>${p}</li>`).join('')}
    </ul>
  `;

  card.onclick = () => {
    classCards.forEach(c => {
      c.style.border = "2px solid rgba(255, 255, 255, 0.1)";
      c.style.background = "rgba(255, 255, 255, 0.05)";
      c.style.boxShadow = "none";
    });
    
    card.style.border = "2px solid #00ffff";
    card.style.background = "rgba(0, 255, 255, 0.1)";
    card.style.boxShadow = "0 0 15px rgba(0, 255, 255, 0.3)";
    
    selectedClassId = cls.id;
    confirmBtn.style.opacity = "1";
    confirmBtn.style.pointerEvents = "auto";
  };
  
  card.onmouseenter = () => {
    if (selectedClassId !== cls.id) card.style.background = "rgba(255, 255, 255, 0.1)";
  };
  card.onmouseleave = () => {
    if (selectedClassId !== cls.id) card.style.background = "rgba(255, 255, 255, 0.05)";
  };

  classCards.push(card);
  classGrid.appendChild(card);
});

classOverlay.appendChild(confirmBtn);

/* ===============================
   UI Overlay Setup
================================ */
export const overlay = document.createElement("div");
overlay.style.position = "fixed";
overlay.style.left = "10px";
overlay.style.top = "10px";
overlay.style.color = "white";
overlay.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
overlay.style.padding = "10px";
overlay.style.borderRadius = "5px";
overlay.style.fontFamily = "monospace";
overlay.style.fontSize = "14px";
overlay.style.pointerEvents = "none";
overlay.style.userSelect = "none";
overlay.style.zIndex = "100";
document.body.appendChild(overlay);

export const coordsHUD = document.createElement("div");
coordsHUD.style.position = "fixed";
coordsHUD.style.top = "12px";
coordsHUD.style.right = "12px";
coordsHUD.style.background = "rgba(0,0,0,0.6)";
coordsHUD.style.color = "white";
coordsHUD.style.padding = "8px 10px";
coordsHUD.style.borderRadius = "6px";
coordsHUD.style.fontFamily = "monospace";
coordsHUD.style.fontSize = "14px";
coordsHUD.style.pointerEvents = "none";
coordsHUD.style.userSelect = "none";
coordsHUD.style.zIndex = "150";
coordsHUD.textContent = "XYZ: ...";
document.body.appendChild(coordsHUD);

export const statsHUD = document.createElement("div");
statsHUD.style.position = "fixed";
statsHUD.style.bottom = "90px"; 
statsHUD.style.left = "50%";
statsHUD.style.transform = "translateX(-50%)";
statsHUD.style.display = "flex";
statsHUD.style.flexDirection = "column";
statsHUD.style.gap = "6px";
statsHUD.style.alignItems = "center";
statsHUD.style.pointerEvents = "none";
statsHUD.style.userSelect = "none";
statsHUD.style.zIndex = "150";
document.body.appendChild(statsHUD);

export const healthHUD = document.createElement("div");
healthHUD.style.display = "flex";
healthHUD.style.gap = "4px";
statsHUD.appendChild(healthHUD);

export const manaHUD = document.createElement("div");
manaHUD.style.display = "flex";
manaHUD.style.gap = "4px";
statsHUD.appendChild(manaHUD);

export const hudHotbarRoot = document.createElement("div");
hudHotbarRoot.style.position = "fixed";
hudHotbarRoot.style.bottom = "10px";
hudHotbarRoot.style.left = "50%";
hudHotbarRoot.style.transform = "translateX(-50%)";
hudHotbarRoot.style.display = "flex";
hudHotbarRoot.style.gap = "6px";
hudHotbarRoot.style.zIndex = "150";
hudHotbarRoot.style.pointerEvents = "auto"; 
document.body.appendChild(hudHotbarRoot);

/* ===============================
   Zone Notification UI
================================ */
export const zoneBanner = document.createElement("div");
zoneBanner.style.position = "fixed";
zoneBanner.style.top = "20%";
zoneBanner.style.left = "50%";
zoneBanner.style.transform = "translate(-50%, -50%)";
zoneBanner.style.display = "flex";
zoneBanner.style.flexDirection = "column";
zoneBanner.style.alignItems = "center";
zoneBanner.style.pointerEvents = "none";
zoneBanner.style.zIndex = "400";
zoneBanner.style.opacity = "0";
zoneBanner.style.transition = "opacity 1s ease-in-out";
document.body.appendChild(zoneBanner);

export const zoneTitle = document.createElement("div");
zoneTitle.style.fontSize = "42px";
zoneTitle.style.fontWeight = "bold";
zoneTitle.style.color = "white";
zoneTitle.style.textShadow = "0 2px 10px rgba(0,0,0,0.8)";
zoneTitle.style.fontFamily = "monospace";
zoneTitle.style.letterSpacing = "2px";
zoneBanner.appendChild(zoneTitle);

export const zoneSub = document.createElement("div");
zoneSub.style.fontSize = "18px";
zoneSub.style.marginTop = "5px";
zoneSub.style.color = "#ddd";
zoneSub.style.textShadow = "0 1px 5px rgba(0,0,0,0.8)";
zoneSub.style.fontFamily = "monospace";
zoneBanner.appendChild(zoneSub);

export let zoneFadeTimeout: any = null;

export function showZoneNotification(title: string, sub: string, subColor: string) {
    zoneTitle.textContent = title;
    zoneSub.textContent = sub;
    zoneSub.style.color = subColor;
    
    zoneBanner.style.opacity = "1";
    
    if (zoneFadeTimeout) clearTimeout(zoneFadeTimeout);
    zoneFadeTimeout = setTimeout(() => {
        zoneBanner.style.opacity = "0";
    }, 4000);
}

// Use persistent URLs for HUD icons
export const HUD_ICON_BASE = "https://api.iconify.design/game-icons";
export const HEART_ICON = `${HUD_ICON_BASE}/heart-beats.svg`;
export const MANA_ICON = `${HUD_ICON_BASE}/power-lightning.svg`;

export function createStatIcon(type: "heart" | "mana", fillState: "full" | "half" | "empty") {
  const img = document.createElement("img");
  img.src = type === "heart" ? HEART_ICON : MANA_ICON;
  img.style.width = "24px";
  img.style.height = "24px";
  img.style.filter = "invert(1)"; // White icon
  img.style.transition = "all 0.2s ease";
  
  img.onerror = () => {
      img.style.display = "none";
  };

  if (fillState === "full") {
    img.style.opacity = "1";
    img.style.filter = type === "heart" 
      ? "drop-shadow(0 0 3px #ff0000) invert(1)" // Red glow hint
      : "drop-shadow(0 0 3px #0055ff) invert(1)"; // Blue glow hint
  } else if (fillState === "half") {
    img.style.opacity = "0.5";
  } else {
    img.style.opacity = "0.2";
  }
  return img;
}

/* ===============================
   Inventory UI
================================ */
export const invRoot = document.createElement("div");
invRoot.style.position = "fixed";
invRoot.style.left = "50%";
invRoot.style.top = "50%";
invRoot.style.transform = "translate(-50%, -50%)";
invRoot.style.width = "760px";
invRoot.style.maxWidth = "95vw";
invRoot.style.background = "rgba(0,0,0,0.78)";
invRoot.style.border = "1px solid rgba(255,255,255,0.15)";
invRoot.style.borderRadius = "10px";
invRoot.style.padding = "14px";
invRoot.style.color = "white";
invRoot.style.fontFamily = "monospace";
invRoot.style.zIndex = "200";
invRoot.style.pointerEvents = "auto";
invRoot.style.display = "none";
invRoot.style.userSelect = "none";
invRoot.style.boxShadow = "0 10px 30px rgba(0,0,0,0.4)";
document.body.appendChild(invRoot);

invRoot.addEventListener("contextmenu", (e) => e.preventDefault());

export const invHeader = document.createElement("div");
invHeader.style.display = "flex";
invHeader.style.alignItems = "center";
invHeader.style.justifyContent = "space-between";
invHeader.style.marginBottom = "10px";
invRoot.appendChild(invHeader);

export const invTitle = document.createElement("div");
invTitle.textContent = "Inventory";
invTitle.style.fontSize = "18px";
invTitle.style.fontWeight = "700";
invHeader.appendChild(invTitle);

export const invHint = document.createElement("div");
invHint.style.opacity = "0.85";
invHint.style.fontSize = "12px";
invHint.textContent = "LMB: pick/place/stack | RMB: half/place-one | Shift+LMB: quick move | Dbl-Click: Use";
invHeader.appendChild(invHint);

export const invMain = document.createElement("div");
invMain.style.display = "grid";
invMain.style.gridTemplateColumns = "1fr 260px";
invMain.style.gap = "12px";
invRoot.appendChild(invMain);

export const invLeft = document.createElement("div");
invLeft.style.display = "flex";
invLeft.style.flexDirection = "column";
invLeft.style.gap = "10px";
invMain.appendChild(invLeft);

export const invRight = document.createElement("div");
invRight.style.display = "flex";
invRight.style.flexDirection = "column";
invRight.style.gap = "10px";
invMain.appendChild(invRight);

export const cursorRow = document.createElement("div");
cursorRow.style.display = "flex";
cursorRow.style.alignItems = "center";
cursorRow.style.gap = "10px";
cursorRow.style.padding = "8px";
cursorRow.style.border = "1px solid rgba(255,255,255,0.12)";
cursorRow.style.borderRadius = "8px";
cursorRow.style.background = "rgba(255,255,255,0.05)";
invLeft.appendChild(cursorRow);

export const cursorLabel = document.createElement("div");
cursorLabel.textContent = "Cursor:";
cursorLabel.style.opacity = "0.9";
cursorRow.appendChild(cursorLabel);

export const cursorSlotEl = document.createElement("div");
cursorSlotEl.style.width = "64px";
cursorSlotEl.style.height = "64px";
cursorSlotEl.style.borderRadius = "8px";
cursorSlotEl.style.border = "1px solid rgba(255,255,255,0.18)";
cursorSlotEl.style.display = "flex";
cursorSlotEl.style.flexDirection = "column";
cursorSlotEl.style.alignItems = "center";
cursorSlotEl.style.justifyContent = "center";
cursorSlotEl.style.background = "rgba(0,0,0,0.35)";
cursorSlotEl.style.position = "relative";
cursorRow.appendChild(cursorSlotEl);

export const cursorNameEl = document.createElement("div");
cursorNameEl.style.fontSize = "11px";
cursorNameEl.style.opacity = "0.95";
cursorNameEl.style.textAlign = "center";
cursorNameEl.style.padding = "0 6px";
cursorNameEl.style.wordBreak = "break-word";
cursorRow.appendChild(cursorNameEl);

export const invGridWrap = document.createElement("div");
invGridWrap.style.display = "flex";
invGridWrap.style.flexDirection = "column";
invGridWrap.style.gap = "10px";
invLeft.appendChild(invGridWrap);

export const hotbarLabel = document.createElement("div");
hotbarLabel.textContent = "Hotbar (1–5)";
hotbarLabel.style.opacity = "0.9";
invGridWrap.appendChild(hotbarLabel);

export const hotbarGrid = document.createElement("div");
hotbarGrid.style.display = "grid";
hotbarGrid.style.gridTemplateColumns = "repeat(5, 64px)";
hotbarGrid.style.gap = "8px";
invGridWrap.appendChild(hotbarGrid);

export const backpackLabel = document.createElement("div");
backpackLabel.textContent = "Backpack";
backpackLabel.style.opacity = "0.9";
invGridWrap.appendChild(backpackLabel);

export const backpackGrid = document.createElement("div");
backpackGrid.style.display = "grid";
backpackGrid.style.gridTemplateColumns = "repeat(5, 64px)";
backpackGrid.style.gap = "8px";
invGridWrap.appendChild(backpackGrid);

export const craftCard = document.createElement("div");
craftCard.style.padding = "10px";
craftCard.style.border = "1px solid rgba(255,255,255,0.12)";
craftCard.style.borderRadius = "8px";
craftCard.style.background = "rgba(255,255,255,0.05)";
invRight.appendChild(craftCard);

export const craftTitle = document.createElement("div");
craftTitle.textContent = "Crafting (basic)";
craftTitle.style.fontWeight = "700";
craftTitle.style.marginBottom = "8px";
craftCard.appendChild(craftTitle);

export const craftList = document.createElement("div");
craftList.style.display = "flex";
craftList.style.flexDirection = "column";
craftList.style.gap = "8px";
craftCard.appendChild(craftList);

export const craftStatus = document.createElement("div");
craftStatus.style.opacity = "0.9";
craftStatus.style.fontSize = "12px";
craftStatus.textContent = "";
invRight.appendChild(craftStatus);

export function mkButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.width = "100%";
  b.style.padding = "10px 10px";
  b.style.borderRadius = "8px";
  b.style.border = "1px solid rgba(255,255,255,0.2)";
  b.style.background = "rgba(0,0,0,0.25)";
  b.style.color = "white";
  b.style.cursor = "pointer";
  b.style.fontFamily = "monospace";
  b.style.fontSize = "13px";
  b.onmouseenter = () => (b.style.background = "rgba(255,255,255,0.10)");
  b.onmouseleave = () => (b.style.background = "rgba(0,0,0,0.25)");
  return b;
}