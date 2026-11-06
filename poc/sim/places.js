// Places of interest and field notes (T3-2, GDD 10, Appendix C). The sim keeps a list of the places worth a pin on the
// map, made each time it is asked from what it holds (sim.places()), and a field guide: each kind's note unlocks the
// first time the driven wasp reaches a place of that kind, and is kept in the save (sim.guide: kind -> the day it was
// found). Every note is a true fact with its source, from Appendix C. The C# twin is core/Sting.Core/SimPlaces.cs.

// every: how often (ticks) the guide looks for a place reached; reach: how near counts as reached, by kind (m)
export const PLACES = { every: 30, reach: 2.5, reachBy: { town: 24, exterminator: 4, line: 4, nest: 4 } };

// the kinds in the order the guide lists them, each with its note and source
export const FIELD_NOTES = {
  nest: {
    title: 'The nest',
    note: 'A yellowjacket queen builds 20 to 30 cells before she lays. Colonies start in spring and decline in autumn; at their peak they rear thousands of workers, with 3,000 to 8,000 larvae.',
    source: 'Wikipedia, Vespula vulgaris',
  },
  line: {
    title: 'Colonies of the line',
    note: 'Only mated young queens outlive the year. They winter under bark or in walls, and each one founds a colony of her own in spring.',
    source: 'Penn State Extension, European Hornet; Wikipedia, Vespula vulgaris',
  },
  rival: {
    title: 'A rival nest',
    note: 'The southern yellowjacket is a social parasite: in late spring its queen often takes over a small eastern yellowjacket nest, sometimes killing the queen there, and her colony grows in the host\'s nest.',
    source: 'Wikipedia, Vespula squamosa; UMass Extension, Yellowjackets',
  },
  hive: {
    title: 'A honeybee hive',
    note: 'A honeybee colony holds 2,000 to 60,000 workers. It lives for years: it stores honey and pollen in autumn and winters as a tight cluster eating its stores.',
    source: 'University of Georgia Honey Bee Program, Honey Bee Biology',
  },
  swarm: {
    title: 'A swarm',
    note: 'A crowded colony rears daughter queens; the old queen leaves with up to 60% of the workers, and the swarm moves into a new home within a day.',
    source: 'University of Georgia Honey Bee Program, Honey Bee Biology',
  },
  water: {
    title: 'Water',
    note: 'On hot days social wasps carry water home: paper wasps spread droplets on the comb and cool the nest by evaporation.',
    source: 'Stabentheiner et al., Scientific Reports 12:3372 (2022)',
  },
  town: {
    title: 'Squares and beer gardens',
    note: 'Late in the season yellowjackets forage mostly for sugar, and they like the same food people eat outside at picnics and fairs.',
    source: 'UMass Extension, Yellowjackets',
  },
  light: {
    title: 'Porch lights',
    note: 'The European hornet flies at night and is drawn to porch lights. It hunts grasshoppers, flies and yellowjackets.',
    source: 'Penn State Extension, European Hornet',
  },
  site: {
    title: 'Nest sites',
    note: 'Yellowjackets nest in old rodent burrows, holes and voids in walls; hornets in hollow trees and wall voids.',
    source: 'Utah State University Extension, Western Yellowjacket; Penn State Extension, European Hornet',
  },
  exterminator: {
    title: 'The exterminator',
    note: 'Nests are treated at night or at dusk, when it is cooler and the wasps are less active.',
    source: 'Utah State University Extension, Western Yellowjacket; UMass Extension, Yellowjackets',
  },
};
export const PLACE_KINDS = Object.keys(FIELD_NOTES);
