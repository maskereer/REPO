# CROSS RADAR

Αυτόνομο dashboard παρακολούθησης ροής (CVD Spot vs Futures), δυναμικών ζωνών Demand / Liquidity Pools, αυτόματων σημείων Pivot και Hyperliquid funding/positioning σε δολάρια ($).

## Περιεχόμενα Repository
- `index.html`: Κύρια δομή διεπαφής του CROSS RADAR.
- `styles.css`: Στυλ και διάταξη dashboard.
- `app.js`: Μηχανή auto-snapshots (`15m`, `1h`, `4h`, `1D`), adaptive polling (`45s Moderate` ↔ `5s Turbo`), δυναμικές ζώνες & pivots, Situation Summary και Capital Ratio ($).

## Χρήση στο GitHub Pages
1. Ανέβασε τα αρχεία `index.html`, `styles.css`, `app.js` και `README.md` στο νέο repository.
2. Ενεργοποίησε το **GitHub Pages** από τις ρυθμίσεις (`Settings -> Pages -> Deploy from a branch -> main / root`).
3. Άνοιξε τη σελίδα — όλα υπολογίζονται δυναμικά χωρίς χειροκίνητες προεπιλογές.
