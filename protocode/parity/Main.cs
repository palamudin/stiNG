using System; using Sting.Core;
static class P { static int Main() {
  foreach (ulong id in new ulong[]{1,2,3,0xDEADBEEFCAFEBABEUL,12345678901234567UL}) {
    var h = HumanFactory.Traits(42, id);
    Console.WriteLine($"{id} {h.ReactionTicks} {(int)h.Style} {h.HeightM} {h.ArmRatio} {h.Flexibility} {h.Girth}");
  }
  Console.WriteLine(Rng.Hash(42, RngDomain.WorldGen, 7, 8, 9).ToString("x16"));
  return 0; } }
