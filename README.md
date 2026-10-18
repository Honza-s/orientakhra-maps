# Mapy pro Orienťák

Mapy pro hru [Orienťák](https://obapp.safka.eu). Každá mapa se vyrábí automaticky z otevřených dat:

- **ČÚZK – DMR 5G** (výškový model terénu) a **DMP 1G** (povrch včetně stromů). Jde o otevřená data ČÚZK.
- **OpenStreetMap** (cesty, voda, budovy, ploty). © přispěvatelé OpenStreetMap, licence ODbL.

Hra si mapy stahuje přes jsDelivr (`cdn.jsdelivr.net/gh/Honza-s/orientakhra-maps@main/maps/<id>/…`)
a seznam map čte z `catalog.json`.

## Nová mapa

**Z GitHubu:** v Actions spusť „Vyrobit mapu“ a vyplň id, název a bbox. Žádost s těmito údaji vytvoří hra
v *Mapy → Chci novou mapu*. Mapa se uloží za pár minut.

**Lokálně:**

```bash
npm install
npm run build-map -- --id krcsky-les --name "Hrádek – Krčský les" --place "Praha 4" --bbox 50.013,14.451,50.040,14.493
```

## Co je ve složce mapy

| soubor | obsah |
|---|---|
| `meta.json` | rozměry, počátek v UTM 33N, výškový rozsah |
| `terrain.png` | 2 m/px; R,G = výška v cm nad `hmin`, B = výška porostu ×4 |
| `cover.png` | 1 m/px; R = typ povrchu (les, louka, hustník, cesta, voda, zástavba…) |
| `map.webp` | orienťácká mapa 1:10 000 (1,25 px/m) |
| `ground.webp` | barva země pro 3D |
| `features.json` | místa vhodná pro kontroly |
