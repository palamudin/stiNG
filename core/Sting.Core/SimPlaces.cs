using System.Collections.Generic;
using static Sting.Core.R;

namespace Sting.Core
{
    /// a place worth a pin on the map (sim.js places, T3-2): its kind, where it is, and a key naming it the same every time
    public sealed class Place { public string kind, key; public Num x, y, z; }

    /// Places of interest and field notes (T3-2, GDD 10, Appendix C; poc/sim/places.js). Every note is a true fact with
    /// its source; a kind's note unlocks the first time the driven wasp reaches a place of that kind, and is kept in the save
    public static class Places
    {
        public const int Every = 30; public static readonly Num Reach = 2.5;
        public static Num ReachOf(string kind) => kind == "town" ? (Num)24 : kind == "exterminator" || kind == "line" || kind == "nest" ? (Num)4 : Reach;
        public static readonly (string kind, string title, string note, string source)[] Notes =
        {
            ("nest", "The nest", "A yellowjacket queen builds 20 to 30 cells before she lays. Colonies start in spring and decline in autumn; at their peak they rear thousands of workers, with 3,000 to 8,000 larvae.", "Wikipedia, Vespula vulgaris"),
            ("line", "Colonies of the line", "Only mated young queens outlive the year. They winter under bark or in walls, and each one founds a colony of her own in spring.", "Penn State Extension, European Hornet; Wikipedia, Vespula vulgaris"),
            ("rival", "A rival nest", "The southern yellowjacket is a social parasite: in late spring its queen often takes over a small eastern yellowjacket nest, sometimes killing the queen there, and her colony grows in the host's nest.", "Wikipedia, Vespula squamosa; UMass Extension, Yellowjackets"),
            ("hive", "A honeybee hive", "A honeybee colony holds 2,000 to 60,000 workers. It lives for years: it stores honey and pollen in autumn and winters as a tight cluster eating its stores.", "University of Georgia Honey Bee Program, Honey Bee Biology"),
            ("swarm", "A swarm", "A crowded colony rears daughter queens; the old queen leaves with up to 60% of the workers, and the swarm moves into a new home within a day.", "University of Georgia Honey Bee Program, Honey Bee Biology"),
            ("water", "Water", "On hot days social wasps carry water home: paper wasps spread droplets on the comb and cool the nest by evaporation.", "Stabentheiner et al., Scientific Reports 12:3372 (2022)"),
            ("town", "Squares and beer gardens", "Late in the season yellowjackets forage mostly for sugar, and they like the same food people eat outside at picnics and fairs.", "UMass Extension, Yellowjackets"),
            ("light", "Porch lights", "The European hornet flies at night and is drawn to porch lights. It hunts grasshoppers, flies and yellowjackets.", "Penn State Extension, European Hornet"),
            ("site", "Nest sites", "Yellowjackets nest in old rodent burrows, holes and voids in walls; hornets in hollow trees and wall voids.", "Utah State University Extension, Western Yellowjacket; Penn State Extension, European Hornet"),
            ("exterminator", "The exterminator", "Nests are treated at night or at dusk, when it is cooler and the wasps are less active.", "Utah State University Extension, Western Yellowjacket; UMass Extension, Yellowjackets"),
        };
    }

    public sealed partial class Sim
    {
        /// the field guide (T3-2): kind -> the day its note was found, in the order found
        public Dictionary<string, long> guide = new Dictionary<string, long>();
        public List<string> guideOrder = new List<string>();

        /// the places worth a pin (sim.js places): the nest, the line's colonies, then each active chunk's rival nest, hives,
        /// water, town centre, porch lights and nest sites, then swarms and the exterminator
        public List<Place> Places()
        {
            var o = new List<Place>();
            void Add(string kind, Num x, Num y, Num z, string key) => o.Add(new Place { kind = kind, x = x, y = y, z = z, key = kind + ":" + key });
            if (colony.nestAlive && colony.sited) { var e = nest.entrance; Add("nest", e.x, e.y, e.z, "own"); }
            foreach (var sc in line) if (sc.colony.nestAlive) { var e = sc.nest.entrance; Add("line", e.x, e.y, e.z, sc.id.ToString()); }
            foreach (var rec in activeChunks)
            {
                var c = rec.content; string k = World.ChunkKey(rec.cx, rec.cz);
                if (c.rival != null) Add("rival", c.rival.ex, c.rival.ey, c.rival.ez, k);
                var hv = HivesIn(rec); for (int j = 0; j < hv.Count; j++) Add("hive", hv[j].ex, hv[j].ey, hv[j].ez, k + ":" + j);
                foreach (var wt in WaterIn(rec)) if (wt.kind != "puddle") Add("water", wt.x, wt.y, wt.z, k + ":" + wt.i);
                if (c.use == "town") Add("town", (Num)rec.cx * T.chunk.size, 0, (Num)rec.cz * T.chunk.size, k);
                foreach (var l in LightsIn(rec)) Add("light", l.x, l.y, l.z, k + ":" + l.si);
                var S = SitesIn(rec);
                for (int j = 0; j < S.hollows.Count; j++) Add("site", S.hollows[j].p.x, S.hollows[j].p.y, S.hollows[j].p.z, k + ":h" + j);
                for (int j = 0; j < S.holes.Count; j++) Add("site", S.holes[j].x, 0, S.holes[j].z, k + ":g" + j);
            }
            for (int j = 0; j < swarms.Count; j++) Add("swarm", swarms[j].biv.x, swarms[j].biv.y, swarms[j].biv.z, j.ToString());
            if (ext != null && ext.hm != null && ext.state == "active") Add("exterminator", ext.hm.x, 1, ext.hm.z, ext.visit.ToString());
            return o;
        }

        /// a kind's note unlocks the first time the driven wasp reaches a place of that kind (sim.js _guideTick)
        void GuideTick()
        {
            var w = Driven();
            if (w == null || guide.Count >= Sting.Core.Places.Notes.Length) return;
            foreach (var p in Places())
            {
                if (guide.ContainsKey(p.kind)) continue;
                Num r = Sting.Core.Places.ReachOf(p.kind); bool flat = p.kind == "town";
                if (Sq(w.x - p.x) + Sq(w.z - p.z) + (flat ? 0 : Sq(w.y - p.y)) > r * r) continue;
                guide[p.kind] = day; guideOrder.Add(p.kind);
                Emit("fieldNote", ("kind", p.kind), ("day", day));
            }
        }
    }
}
