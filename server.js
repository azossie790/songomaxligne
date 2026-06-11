const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ÉTAT DU JEU ──────────────────────────────────────────────────────────────
// Plateau : cases[0..6] = SUD (joueur SUD), cases[7..13] = NORD (joueur NORD)
// cases[0] = case 1 SUD (gauche SUD), cases[6] = case 7 SUD (droite SUD)
// cases[7] = case 1 NORD (gauche NORD), cases[13] = case 7 NORD (droite NORD)
// Ordre NORD vu par NORD : cases[13] case1 ... cases[7] case7
// Ordre SUD vu par SUD  : cases[0] case1 ... cases[6] case7

function creerPartie() {
  return {
    plateau: Array(14).fill(5),   // 14 cases, 5 graines chacune = 70
    scores: { SUD: 0, NORD: 0 },
    tour: 'SUD',                  // SUD commence
    statut: 'attente',            // attente | en_cours | termine
    joueurs: { SUD: null, NORD: null },
    message: '',
    dernierCoup: null,
    fin: null
  };
}

let parties = {}; // stockage en mémoire

// ─── LOGIQUE DU JEU ───────────────────────────────────────────────────────────

// Indices du territoire adverse selon le joueur qui joue
function territoireAdverse(joueur) {
  // SUD joue → territoire adverse = NORD = cases[7..13]
  // NORD joue → territoire adverse = SUD = cases[0..6]
  return joueur === 'SUD' ? [7,8,9,10,11,12,13] : [0,1,2,3,4,5,6];
}

function territoirePropre(joueur) {
  return joueur === 'SUD' ? [0,1,2,3,4,5,6] : [7,8,9,10,11,12,13];
}

// Case 1 adverse (interdite de prise directe, sauf chaîne)
// Case 1 = la plus à gauche VU PAR L'ADVERSAIRE
// Pour SUD : case 1 adverse = NORD case 1 = index 7 (gauche NORD vu par NORD = droite vu par SUD)
// NB: "la plus à gauche de l'adversaire" = case[13] pour SUD (droite plateau = gauche NORD)
//     Et case[7] pour NORD (gauche plateau = gauche SUD vu par SUD = droite vu par NORD... )
// Selon la disposition :
//   NORD:  1(idx13) 2(idx12) 3(idx11) 4(idx10) 5(idx9) 6(idx8) 7(idx7)
//   SUD :  7(idx6)  6(idx5)  5(idx4)  4(idx3)  3(idx2) 2(idx1) 1(idx0)
// Case 1 NORD (plus à gauche vu par NORD) = idx 13
// Case 1 SUD  (plus à gauche vu par SUD ) = idx 0
// Case 7 NORD = idx 7, Case 7 SUD = idx 6

function case1Adverse(joueur) {
  // La case 1 de l'adversaire (interdite de prise directe)
  return joueur === 'SUD' ? 13 : 0;
}

function case7Propre(joueur) {
  return joueur === 'SUD' ? 6 : 7;
}

// Semis depuis une case: retourne le nouvel indice de fin et le plateau modifié
function semer(plateau, caseDepart, joueur) {
  let p = [...plateau];
  let graines = p[caseDepart];
  p[caseDepart] = 0;
  let pos = caseDepart;
  while (graines > 0) {
    pos = (pos + 1) % 14;
    // On ne saute aucune case (pas de case "grande" dans ce Songo)
    p[pos]++;
    graines--;
  }
  return { plateau: p, dernierIndex: pos };
}

function totalGraines(plateau) {
  return plateau.reduce((a, b) => a + b, 0);
}

function totalCamp(plateau, joueur) {
  return territoirePropre(joueur).reduce((s, i) => s + plateau[i], 0);
}

// Prises en chaîne depuis dernierIndex vers la gauche dans territoire adverse
function effectuerPrises(plateau, dernierIndex, joueur) {
  let p = [...plateau];
  let prisesTotal = 0;
  const c1adv = case1Adverse(joueur);
  const terAdv = territoireAdverse(joueur);

  // Vérifier si dernierIndex est dans le territoire adverse
  if (!terAdv.includes(dernierIndex)) return { plateau: p, prises: 0 };

  // Règle spéciale case 1 adverse : si distribution s'y termine
  if (dernierIndex === c1adv) {
    // On récolte juste 1 graine (la dernière distribuée) — seulement si tour complet
    // (le semis a fait au moins 14 pas → déjà géré par la logique de semer)
    // On prend 1 graine uniquement
    prisesTotal = 1;
    p[c1adv]--;
    return { plateau: p, prises: prisesTotal };
  }

  // Prises normales + chaîne
  // On parcourt depuis dernierIndex vers "gauche" (décroissant dans terAdv)
  let i = dernierIndex;
  while (terAdv.includes(i)) {
    const val = p[i];
    if (i === c1adv) {
      // Case 1 adverse incluse dans chaîne : on peut prendre si 2-4 graines
      if (val >= 2 && val <= 4) {
        prisesTotal += val;
        p[i] = 0;
        i = i - 1; // continuer chaîne
        // Vérifier limites
        if (!terAdv.includes(i)) break;
      } else break;
    } else {
      if (val >= 2 && val <= 4) {
        prisesTotal += val;
        p[i] = 0;
        i = i - 1;
        if (!terAdv.includes(i)) break;
      } else break;
    }
  }

  return { plateau: p, prises: prisesTotal };
}

// Vérifier si un coup vide complètement le camp adverse → interdit
function viderait(plateau, caseDepart, joueur) {
  const { plateau: p2 } = semer(plateau, caseDepart, joueur);
  // Appliquer prises simulées
  const { dernierIndex } = semer(plateau, caseDepart, joueur);
  const terAdv = territoireAdverse(joueur);
  let pSim = [...p2];
  // Simuler prises
  const res = effectuerPrises(pSim, dernierIndex, joueur);
  return terAdv.every(i => res.plateau[i] === 0);
}

// Vérifier règle solidarité
function campVide(plateau, joueur) {
  return territoirePropre(joueur).every(i => plateau[i] === 0);
}

function coupsPossibles(plateau, joueur) {
  return territoirePropre(joueur).filter(i => plateau[i] > 0);
}

// Combien de graines un coup envoie dans le territoire adverse
function grainesDansCampAdverse(plateau, caseDepart, joueur) {
  const { plateau: p2 } = semer(plateau, caseDepart, joueur);
  const terAdv = territoireAdverse(joueur);
  const avant = terAdv.reduce((s, i) => s + plateau[i], 0);
  const apres = terAdv.reduce((s, i) => s + p2[i], 0);
  return apres - avant;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Créer ou rejoindre une partie
app.post('/api/rejoindre', (req, res) => {
  const { partieId, joueur } = req.body;
  if (!partieId) return res.status(400).json({ erreur: 'partieId requis' });

  if (!parties[partieId]) {
    parties[partieId] = creerPartie();
  }
  const partie = parties[partieId];

  if (joueur === 'SUD' || joueur === 'NORD') {
    if (!partie.joueurs[joueur]) {
      partie.joueurs[joueur] = true;
    }
    // Démarrer si les deux sont connectés
    if (partie.joueurs.SUD && partie.joueurs.NORD && partie.statut === 'attente') {
      partie.statut = 'en_cours';
      partie.message = 'Partie démarrée ! SUD commence.';
    }
    return res.json({ ok: true, partie: sanitize(partie, joueur) });
  }
  return res.status(400).json({ erreur: 'Joueur invalide (SUD ou NORD)' });
});

// État de la partie (polling Ajax)
app.get('/api/etat/:partieId/:joueur', (req, res) => {
  const { partieId, joueur } = req.params;
  const partie = parties[partieId];
  if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });
  res.json(sanitize(partie, joueur));
});

// Jouer un coup
app.post('/api/jouer', (req, res) => {
  const { partieId, joueur, caseIndex } = req.body;
  const partie = parties[partieId];
  if (!partie) return res.status(404).json({ erreur: 'Partie introuvable' });
  if (partie.statut !== 'en_cours') return res.status(400).json({ erreur: 'Partie non active' });
  if (partie.tour !== joueur) return res.status(400).json({ erreur: "Ce n'est pas votre tour" });

  const terPropre = territoirePropre(joueur);
  if (!terPropre.includes(caseIndex)) return res.status(400).json({ erreur: 'Case invalide' });
  if (partie.plateau[caseIndex] === 0) return res.status(400).json({ erreur: 'Case vide' });

  let plateau = [...partie.plateau];
  const adversaire = joueur === 'SUD' ? 'NORD' : 'SUD';
  let message = '';

  // ── Règle solidarité ──
  if (campVide(plateau, adversaire)) {
    const grainesEnvoyees = grainesDansCampAdverse(plateau, caseIndex, joueur);
    const coupsDispos = coupsPossibles(plateau, joueur);
    const maxGraines = Math.max(...coupsDispos.map(i => grainesDansCampAdverse(plateau, i, joueur)));

    if (maxGraines < 7) {
      // Transmettre maximum possible
      if (grainesEnvoyees < maxGraines) {
        return res.status(400).json({ erreur: `Solidarité : jouez le coup qui envoie le maximum (${maxGraines}) de graines chez l'adversaire.` });
      }
    } else {
      // Doit envoyer au moins 7
      if (grainesEnvoyees < 7) {
        return res.status(400).json({ erreur: 'Solidarité : vous devez envoyer au moins 7 graines chez l\'adversaire.' });
      }
    }
  }

  // ── Règle interdit case 7 ──
  const c7 = case7Propre(joueur);
  if (caseIndex === c7 && plateau[c7] <= 2) {
    // 1 ou 2 graines depuis case 7 → interdire sauf solidarité forcée
    const grainesAdv = grainesDansCampAdverse(plateau, caseIndex, joueur);
    if (grainesAdv > 0 && plateau[c7] <= 2) {
      // Ces graines reviennent à l'adversaire
      partie.scores[adversaire] += plateau[c7];
      plateau[c7] = 0;
      partie.plateau = plateau;
      partie.tour = adversaire;
      partie.message = `Case 7 interdite : ${plateau[c7]} graine(s) reviennent à ${adversaire}.`;
      verifierFin(partie);
      return res.json(sanitize(partie, joueur));
    }
  }

  // ── Vérifier si vide camp adverse ──
  if (viderait(plateau, caseIndex, joueur)) {
    // Coup joué mais aucune prise
    const { plateau: p2, dernierIndex } = semer(plateau, caseIndex, joueur);
    partie.plateau = p2;
    partie.tour = adversaire;
    partie.message = 'Coup joué sans prise (interdit de vider le camp adverse).';
    verifierFin(partie);
    return res.json(sanitize(partie, joueur));
  }

  // ── Semis normal ──
  const { plateau: p2, dernierIndex } = semer(plateau, caseIndex, joueur);

  // ── Prises ──
  const { plateau: p3, prises } = effectuerPrises(p2, dernierIndex, joueur);

  partie.plateau = p3;
  partie.scores[joueur] += prises;
  partie.dernierCoup = { joueur, caseIndex, prises };

  if (prises > 0) {
    message = `${joueur} prend ${prises} graine(s) !`;
  } else {
    message = `${joueur} a semé depuis la case ${caseIndex + 1}.`;
  }

  partie.tour = adversaire;
  partie.message = message;

  verifierFin(partie);
  res.json(sanitize(partie, joueur));
});

function verifierFin(partie) {
  const { plateau, scores } = partie;
  const total = totalGraines(plateau);

  // Moins de 10 graines
  if (total < 10) {
    // Chaque joueur récupère son camp
    scores.SUD += territoirePropre('SUD').reduce((s, i) => s + plateau[i], 0);
    scores.NORD += territoirePropre('NORD').reduce((s, i) => s + plateau[i], 0);
    partie.plateau = Array(14).fill(0);
    terminerPartie(partie);
    return;
  }

  // Un joueur a 40+
  if (scores.SUD >= 40 || scores.NORD >= 40) {
    terminerPartie(partie);
    return;
  }

  // Vérifier solidarité impossible
  const adversaireTour = partie.tour === 'SUD' ? 'NORD' : 'SUD';
  if (campVide(plateau, partie.tour)) {
    const coups = coupsPossibles(plateau, adversaireTour);
    const peutEnvoyer = coups.some(i => grainesDansCampAdverse(plateau, i, adversaireTour) > 0);
    if (!peutEnvoyer) {
      // Fin
      scores.SUD += territoirePropre('SUD').reduce((s, i) => s + plateau[i], 0);
      scores.NORD += territoirePropre('NORD').reduce((s, i) => s + plateau[i], 0);
      partie.plateau = Array(14).fill(0);
      terminerPartie(partie);
    }
  }
}

function terminerPartie(partie) {
  partie.statut = 'termine';
  const { SUD, NORD } = partie.scores;
  if (SUD >= 40) partie.fin = `SUD gagne avec ${SUD} graines !`;
  else if (NORD >= 40) partie.fin = `NORD gagne avec ${NORD} graines !`;
  else partie.fin = `Partie nulle — SUD: ${SUD}, NORD: ${NORD}`;
  partie.message = partie.fin;
}

function sanitize(partie, joueur) {
  return {
    plateau: partie.plateau,
    scores: partie.scores,
    tour: partie.tour,
    statut: partie.statut,
    message: partie.message,
    joueurs: partie.joueurs,
    fin: partie.fin,
    monRole: joueur
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Songo serveur démarré sur http://localhost:${PORT}`));
