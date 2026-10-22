using System; using Sting.Core;
static class P {
  static decimal D(Fix64 f) => (decimal)f.Raw / 4294967296m;
  static int Main() {
    int fail = 0; var rnd = new Random(1);
    for (int i = 0; i < 200000; i++) {
      long a = (long)(rnd.NextDouble()*2e12 - 1e12) , b = (long)(rnd.NextDouble()*2e12 - 1e12);
      if (rnd.Next(3)==0) { a = rnd.Next(-5000000,5000000)*(1L<<20); }
      var fa = Fix64.FromRaw(a); var fb = Fix64.FromRaw(b);
      decimal exp = D(fa)*D(fb);
      if (Math.Abs(exp) < 2e9m) { decimal got = D(fa*fb); if (Math.Abs(got-exp) > 2.4e-10m) { if (fail++<5) Console.WriteLine($"mul {D(fa)}*{D(fb)} got {got} exp {exp}"); } }
      if (b != 0) { decimal ed = D(fa)/D(fb); if (Math.Abs(ed) < 2e9m) { decimal gd = D(fa/fb); if (Math.Abs(gd-ed) > 2.4e-10m) { if (fail++<10) Console.WriteLine($"div {D(fa)}/{D(fb)} got {gd} exp {ed}"); } } }
    }
    Console.WriteLine($"FromRatio(183,1000) = {Fix64.FromRatio(183,1000)}");
    // Resolve determinism + invariant
    var zone = new ZoneDef{ BaseReach=Fix64.FromRatio(10,100), BackSensitivity=Fix64.One, GirthSensitivity=Fix64.One, StiffnessSensitivity=Fix64.Half, Sensitivity=Fix64.One, Policy=ResponsePolicy.Contort, HelperMaySwat=true };
    var t = new ResolveTuning{ Reach=new ReachTuning{ArmCoef=Fix64.Half,FlexCoef=Fix64.FromRatio(3,10),GirthCoef=Fix64.FromRatio(2,10),AgeCoef=Fix64.FromRatio(1,10),MinReachToSwat=Fix64.FromRatio(25,100)},
      JabPain=Fix64.FromRatio(3,10), FullPain=Fix64.One, PreciseRadius=Fix64.FromRatio(4,100), FlailerRadius=Fix64.FromRatio(10,100), BrushRadius=Fix64.FromRatio(8,100), CoverRadius=Fix64.FromRatio(12,100), ContortRadius=Fix64.FromRatio(15,100),
      ContortExtraTicks=12, HelperNoticeTicks=8, MinConsequenceTicks=11, HelperRangeM=Fix64.FromInt(2), FleePanic=Fix64.FromRatio(8,10) };
    ulong h1=0; int minGap=int.MaxValue; int contorts=0;
    for (ulong id=1; id<=20000; id++) {
      var h = HumanFactory.Traits(42, id);
      var ctx = new HumanContext{ ClothingStiffness=Fix64.Zero, Panic=Fix64.Zero, Companions = id%3==0 ? new[]{ new Companion{Id=id+100000, DistanceM=Fix64.One, ReactionTicks=20, Style=SwatStyle.Precise} } : null };
      var e = new StingEvent{ ContactTick=1000, HumanId=id, Zone=Zone.Acnestis, Mode=StingMode.Full };
      var p = StingResolver.Resolve(e, h, zone, ctx, t);
      if (p.SwatCount>0) { minGap=Math.Min(minGap,(int)(p.Swat0.StartTick-1000)); if (p.Swat0.Kind==SwatKind.Contort) contorts++; h1 = h1*31 + (ulong)p.Swat0.StartTick + (ulong)p.Swat0.Radius.Raw; }
      if (p.SwatCount>1) h1 = h1*31 + (ulong)p.Swat1.StartTick;
    }
    Console.WriteLine($"plan hash {h1:X16}, min swat gap {minGap} ticks, acnestis contorts {contorts}/~(non-freezers)");
    var chunkA = ChunkAuthority.Elect(42, 3, -7, new ulong[]{11,22,33}); var chunkB = ChunkAuthority.Elect(42, 3, -7, new ulong[]{33,11,22});
    Console.WriteLine($"authority order-independent: {chunkA==chunkB}");
    Console.WriteLine(fail==0 ? "ALL ARITHMETIC CHECKS PASSED" : $"FAILURES: {fail}");
    return fail==0 && minGap>=11 && chunkA==chunkB ? 0 : 1;
  }
}
