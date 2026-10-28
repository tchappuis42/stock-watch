"""
Petite fenêtre qui affiche les dernières alertes de stock reçues sur un canal ntfy, en direct.
Python 3, uniquement la bibliothèque standard (rien à installer).
Lancer avec un double-clic (.pyw = pas de console) ou : python ntfy_viewer.pyw
"""
import json
import os
import queue
import re
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime
import tkinter as tk
from tkinter import ttk

# ---------------- Configuration ----------------
SERVEUR = "https://ntfy.sh"
TOPIC = ""                 # laisser vide : lu dans ntfy_topic.txt (à côté du script, pas versionné)
HISTORIQUE = "12h"         # messages déjà reçus à charger au démarrage (ntfy.sh garde ~12h)
MAX_LIGNES = 300           # nombre de lignes gardées dans la fenêtre
TOKEN = None               # "tk_xxx" si ton canal est protégé, sinon None
JOURNAL = False            # True = enregistre chaque message brut dans messages_recus.txt
ALERTE = True              # son + clignotement + bulle quand un article devient commandable
DUREE_BULLE = 30           # secondes avant que la bulle se ferme toute seule
MASQUER_CARTES_UNITE = True  # cache les "carte à l'unité" (affichage et alertes)
# -----------------------------------------------

SEP = " — "  # séparateur utilisé par le bot (tiret long)
DOSSIER = os.path.dirname(os.path.abspath(__file__))
FICHIER_JOURNAL = os.path.join(DOSSIER, "messages_recus.txt")
FICHIER_TOPIC = os.path.join(DOSSIER, "ntfy_topic.txt")


def lire_topic():
    """Le nom du canal est secret : on le garde hors du dépôt Git."""
    if TOPIC:
        return TOPIC
    if os.environ.get("NTFY_TOPIC"):
        return os.environ["NTFY_TOPIC"].strip()
    try:
        with open(FICHIER_TOPIC, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


TOPIC = lire_topic()


# ---------- Réception ----------

def journaliser(ligne_brute):
    if not JOURNAL:
        return
    try:
        with open(FICHIER_JOURNAL, "a", encoding="utf-8") as f:
            f.write(ligne_brute.strip() + "\n")
    except OSError:
        pass


def ouvrir_flux(since):
    url = f"{SERVEUR}/{TOPIC}/json?since={since}"
    req = urllib.request.Request(url)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    # ntfy envoie un "keepalive" toutes les ~45 s, donc 90 s de timeout suffisent
    return urllib.request.urlopen(req, timeout=90)


def ecoute(q):
    """Thread de fond : reste connecté au canal et pousse les messages dans la file."""
    since = HISTORIQUE
    while True:
        try:
            with ouvrir_flux(since) as flux:
                q.put(("etat", "Connecté"))
                for ligne in flux:
                    texte_brut = ligne.decode("utf-8", errors="replace")
                    msg = json.loads(texte_brut)
                    if msg.get("event") == "message":
                        journaliser(texte_brut)
                        since = msg["id"]  # à la reconnexion, on reprend après ce message
                        q.put(("msg", msg))
        except Exception as e:
            q.put(("etat", f"Déconnecté ({type(e).__name__}), nouvel essai dans 5 s…"))
            time.sleep(5)


# ---------- Lecture du format du bot ----------

def boutique_depuis_titre(titre):
    """'🆕 Poke Swiss — Pokémon 30 ans FR — COMMANDABLE' -> 'Poke Swiss'
       'Test OK — Mix-Image — Pokémon 30 ans FR'        -> 'Mix-Image'
       '🚨 COMMANDABLE — <article>' / '👀 En ligne — <article>' -> '' (la boutique est sur la 1re ligne du message)"""
    if titre.startswith(("🚨", "👀")):
        return ""
    morceaux = [m.strip() for m in titre.split(SEP)]
    morceaux[0] = morceaux[0].replace("🆕", "").strip()
    if morceaux and morceaux[0].lower().startswith("test"):
        morceaux = morceaux[1:]
    return morceaux[0] if len(morceaux) >= 2 else ""


def categorie(statut, commandable=None):
    """commandable : ce que le bot en dit (✅/⏳ devant la ligne, tag "orderable"), None s'il ne dit rien.
    Le texte du statut varie trop d'une boutique à l'autre ("en stock", "Ajouter au panier dispo"…)
    pour servir autrement que de repli."""
    s = statut.lower()
    if commandable is None:
        commandable = "commandable" in s and "pas" not in s
    if commandable:
        return "dispo"
    if "bientôt" in s or "pas encore en ligne" in s:
        return "bientot"
    return "indispo"


def decouper_message(msg):
    """Transforme un message ntfy en une ou plusieurs lignes du tableau."""
    boutique = boutique_depuis_titre(msg.get("title", ""))
    heure = datetime.fromtimestamp(msg["time"]).strftime("%d.%m %H:%M")
    lien = msg.get("click", "")
    # alerte d'un seul article commandable (🚨, "🆕 … — COMMANDABLE") : tag "orderable", ou le titre
    # pour les messages envoyés avant ce tag
    alerte_commandable = "orderable" in msg.get("tags", []) or "COMMANDABLE" in msg.get("title", "")
    lignes = []
    masques = 0

    for brut in msg.get("message", "").splitlines():
        marque = brut.strip()[:1]
        ligne = brut.strip().lstrip("✅⏳").strip()
        if not ligne:
            continue
        morceaux = [m.strip() for m in ligne.split(SEP)]

        if len(morceaux) >= 3:
            # "Article — Prix — statut (détails)"
            article, prix = morceaux[0], morceaux[1]
            statut_complet = SEP.join(morceaux[2:])
            if MASQUER_CARTES_UNITE and re.search(r"carte à l.unit", statut_complet, re.I):
                masques += 1
                continue
            # les détails entre parenthèses passent après le nom de l'article
            m = re.match(r"^(.*?)\s*(\(.*\))?$", statut_complet)
            statut, details = m.group(1).strip().strip("[]"), (m.group(2) or "")
            if details:
                article = f"{article} {details}"
            # ✅ / ⏳ : le bot le dit pour cette ligne ; sinon le message entier est une alerte "commandable"
            commandable = {"✅": True, "⏳": False}.get(marque, True if alerte_commandable else None)
            cat = categorie(statut, commandable)
            if cat == "dispo":
                statut = "COMMANDABLE"
            lignes.append({"statut": statut, "boutique": boutique, "article": article,
                           "prix": "" if prix == "?" else prix, "heure": heure,
                           "lien": lien, "cat": cat})
        elif len(morceaux) == 2 and not lignes:
            # ligne d'en-tête du type "400 Coups — Pokémon 30 ans FR"
            boutique = morceaux[0]
        else:
            # info du bot ("+ 11 autres", "aucun article pour l'instant", ...)
            lignes.append({"statut": "", "boutique": boutique, "article": ligne,
                           "prix": "", "heure": heure, "lien": lien, "cat": "info"})

    # si tout le message n'était que des cartes à l'unité, on n'en garde rien (pas de "+ 1 autres" orphelin)
    if masques and all(l["cat"] == "info" for l in lignes):
        return []
    return lignes


# ---------- Fenêtre ----------

class Fenetre(tk.Tk):
    COLONNES = (("statut", "Statut", 150, False), ("boutique", "Boutique", 110, False),
                ("article", "Article", 380, True), ("prix", "Prix", 85, False),
                ("heure", "Reçu", 85, False))

    def __init__(self):
        super().__init__()
        self.title(f"Alertes stock – {TOPIC}")
        self.geometry("860x380")
        self.attributes("-topmost", True)

        self.q = queue.Queue()
        self.demarrage = time.time()
        self._bulle = None
        self.vus = set()
        self.lignes = []   # toutes les lignes, la plus récente en premier
        self.liens = {}

        cadre = ttk.Frame(self)
        cadre.pack(fill="both", expand=True, padx=6, pady=(6, 0))
        self.arbre = ttk.Treeview(cadre, columns=[c[0] for c in self.COLONNES], show="headings")
        for col, titre, largeur, etire in self.COLONNES:
            self.arbre.heading(col, text=titre)
            self.arbre.column(col, width=largeur, stretch=etire)
        defil = ttk.Scrollbar(cadre, orient="vertical", command=self.arbre.yview)
        self.arbre.configure(yscrollcommand=defil.set)
        self.arbre.pack(side="left", fill="both", expand=True)
        defil.pack(side="right", fill="y")

        self.arbre.tag_configure("dispo", foreground="#1b7f2a", font=("Segoe UI", 9, "bold"))
        self.arbre.tag_configure("bientot", foreground="#b26a00")
        self.arbre.tag_configure("indispo", foreground="#777777")
        self.arbre.tag_configure("info", foreground="#999999")
        self.arbre.bind("<Double-1>", self.ouvrir_lien)

        bas = ttk.Frame(self)
        bas.pack(fill="x", padx=6, pady=4)
        self.etat = ttk.Label(bas, text="Connexion…")
        self.etat.pack(side="left")
        self.dessus = tk.BooleanVar(value=True)
        ttk.Checkbutton(bas, text="Toujours au-dessus", variable=self.dessus,
                        command=lambda: self.attributes("-topmost", self.dessus.get())).pack(side="right")
        ttk.Button(bas, text="Tester l'alerte", command=self.tester_alerte).pack(side="right")
        self.seulement_dispo = tk.BooleanVar(value=False)
        ttk.Checkbutton(bas, text="Seulement les commandables", variable=self.seulement_dispo,
                        command=self.afficher).pack(side="right", padx=10)

        threading.Thread(target=ecoute, args=(self.q,), daemon=True).start()
        self.after(200, self.verifier_file)

    def verifier_file(self):
        nouveau = False
        a_signaler = []
        while not self.q.empty():
            genre, contenu = self.q.get()
            if genre == "etat":
                self.etat.config(text=contenu)
            elif contenu["id"] not in self.vus:
                self.vus.add(contenu["id"])
                lignes = decouper_message(contenu)
                self.lignes[:0] = lignes
                del self.lignes[MAX_LIGNES:]
                nouveau = True
                # Alerte seulement pour les vraies nouveautés reçues depuis l'ouverture,
                # pas pour l'historique ni les récapitulatifs "Test"
                recu_en_direct = contenu["time"] >= self.demarrage - 5
                est_test = contenu.get("title", "").lower().startswith("test")
                if recu_en_direct and not est_test:
                    a_signaler += [l for l in lignes if l["cat"] == "dispo"]
        if nouveau:
            self.afficher()
        if a_signaler and ALERTE and not self.est_au_premier_plan():
            self.alerter(a_signaler)
        self.after(200, self.verifier_file)

    # ---------- Alerte ----------

    def tester_alerte(self):
        """Déclenche une fausse alerte dans 5 s : le temps de passer sur une autre fenêtre."""
        exemple = [{"boutique": "Test", "article": "Exemple d'article commandable",
                    "prix": "9.90 CHF", "lien": "", "cat": "dispo"}]
        self.etat.config(text="Alerte de test dans 5 s… passe sur une autre fenêtre")
        self.after(5000, lambda: (self.alerter(exemple), self.etat.config(text="Connecté")))

    def est_au_premier_plan(self):
        return self.state() != "iconic" and self.focus_displayof() is not None

    def alerter(self, lignes):
        # 1) son
        try:
            import winsound
            winsound.PlaySound("SystemExclamation", winsound.SND_ALIAS | winsound.SND_ASYNC)
        except Exception:
            self.bell()

        # 2) l'icône clignote dans la barre des tâches jusqu'à ce que tu reviennes sur la fenêtre
        try:
            import ctypes

            class FLASHWINFO(ctypes.Structure):
                _fields_ = [("cbSize", ctypes.c_uint), ("hwnd", ctypes.c_void_p),
                            ("dwFlags", ctypes.c_uint), ("uCount", ctypes.c_uint),
                            ("dwTimeout", ctypes.c_uint)]
            hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
            info = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, 3 | 12, 0, 0)  # tout + jusqu'au focus
            ctypes.windll.user32.FlashWindowEx(ctypes.byref(info))
        except Exception:
            pass

        # 3) petite bulle en bas à droite de l'écran
        self.bulle(lignes)

    def bulle(self, lignes):
        if getattr(self, "_bulle", None) is not None:
            self._bulle.destroy()
        b = tk.Toplevel(self)
        self._bulle = b
        b.overrideredirect(True)
        b.attributes("-topmost", True)
        b.configure(bg="#1b7f2a")

        contenu = tk.Frame(b, bg="#eaf7ec", padx=12, pady=8)
        contenu.pack(fill="both", expand=True, padx=2, pady=2)
        tk.Label(contenu, text=f"✅ {len(lignes)} article(s) COMMANDABLE", bg="#eaf7ec",
                 fg="#1b7f2a", font=("Segoe UI", 10, "bold"), anchor="w").pack(fill="x")
        for l in lignes[:4]:
            texte = f"{l['boutique']} · {l['article'][:55]}" + (f" · {l['prix']}" if l["prix"] else "")
            tk.Label(contenu, text=texte, bg="#eaf7ec", anchor="w",
                     font=("Segoe UI", 9)).pack(fill="x")
        if len(lignes) > 4:
            tk.Label(contenu, text=f"+ {len(lignes) - 4} autres", bg="#eaf7ec", fg="#777",
                     anchor="w", font=("Segoe UI", 9)).pack(fill="x")
        tk.Label(contenu, text="Clic : ouvrir le produit   ·   clic droit : fermer", bg="#eaf7ec",
                 fg="#777", anchor="w", font=("Segoe UI", 8)).pack(fill="x", pady=(4, 0))

        def ouvrir(_e=None):
            if lignes[0]["lien"]:
                webbrowser.open(lignes[0]["lien"])
            fermer()

        def fermer(_e=None):
            if self._bulle is b:
                self._bulle = None
            b.destroy()

        for w in [b, contenu] + list(contenu.winfo_children()):
            w.bind("<Button-1>", ouvrir)
            w.bind("<Button-3>", fermer)

        b.update_idletasks()
        x = b.winfo_screenwidth() - b.winfo_reqwidth() - 16
        y = b.winfo_screenheight() - b.winfo_reqheight() - 60  # au-dessus de la barre des tâches
        b.geometry(f"+{x}+{y}")
        b.after(DUREE_BULLE * 1000, fermer)

    def afficher(self):
        self.arbre.delete(*self.arbre.get_children())
        self.liens.clear()
        for l in self.lignes:
            if self.seulement_dispo.get() and l["cat"] != "dispo":
                continue
            iid = self.arbre.insert("", "end", tags=(l["cat"],),
                                    values=[l[c[0]] for c in self.COLONNES])
            if l["lien"]:
                self.liens[iid] = l["lien"]

    def ouvrir_lien(self, _event):
        url = self.liens.get(self.arbre.focus())
        if url:
            webbrowser.open(url)


if __name__ == "__main__":
    if not TOPIC:
        from tkinter import messagebox
        racine = tk.Tk()
        racine.withdraw()
        messagebox.showerror("Canal ntfy manquant",
                             "Crée un fichier ntfy_topic.txt à côté du script\n"
                             "et écris dedans le nom de ton canal ntfy.")
        raise SystemExit
    Fenetre().mainloop()
