/**
 * La estrategia de tendencia llevada a dinero, con posiciones simultaneas y tope de capital.
 *
 *   npm run cartera:tendencia -- --lista X.json --cache=V.json [--senal=canal50|canal20|vol2]
 *                                [--coste=0.05] [--capital=1000] [--solo-largos]
 *
 * Cierra lo que faltaba desde el principio: el barrido dice 0,98R por operacion, pero eso no
 * dice cuanto se gana ni cuanto se sufre. Con 31 instrumentos y rupturas, las señales se
 * amontonan en los mismos tramos alcistas, asi que el numero de posiciones abiertas a la vez
 * decide el resultado tanto como la señal.
 *
 * Se compara contra comprar y mantener TODO el universo a partes iguales, que es el control.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { canal, volatilidad, simularRuptura, type SeñalRuptura } from "../forex/rupturas";
import { simularCartera, type Operacion } from "../forex/cartera";
import { indexarPorFecha, calendarioUniverso, estabaDentro } from "../forex/liquidez";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

const SEÑALES: Record<string, { f: (v: Vela[], a: (number | null)[]) => SeñalRuptura[]; stop: number; trail: number }> = {
  canal20: { f: (v) => canal(v, 20), stop: 2, trail: 3 },
  canal50: { f: (v) => canal(v, 50), stop: 3, trail: 3 },
  vol2: { f: (v, a) => volatilidad(v, a, 2), stop: 2, trail: 2 },
  // La mejor del vecindario por amplitud: gana en 30 de 31 instrumentos, no en unos pocos.
  vol2s3: { f: (v, a) => volatilidad(v, a, 2), stop: 3, trail: 2 },
  vol3s3: { f: (v, a) => volatilidad(v, a, 3), stop: 3, trail: 2 },
  // Las de 1h: alli el mejor par del vecindario es stop 1.5, no 2.
  vol2s15: { f: (v, a) => volatilidad(v, a, 2), stop: 1.5, trail: 2 },
  vol1s15: { f: (v, a) => volatilidad(v, a, 1), stop: 1.5, trail: 2 },
};

async function main(): Promise<void> {
  const nombre = txt("senal") ?? "canal50";
  const cfg = SEÑALES[nombre];
  if (!cfg) {
    console.error(`Señal desconocida. Opciones: ${Object.keys(SEÑALES).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const costeR = arg("coste", 0.05);
  // Deslizamiento adverso en fraccion del riesgo, SOLO a la entrada.
  const deslizR = arg("desliz", 0);
  // Coste en puntos basicos del PRECIO (comision + spread reales). 0 = modo antiguo.
  const costeBps = arg("costebps", 0);
  // Tope de exposicion en multiplos del capital. 0 = sin tope (para comparar).
  const maxExpo = arg("expo", 0);
  // Universo dinamico: solo se opera lo que estaba entre los N mas liquidos EN SU MOMENTO.
  // 0 = universo fijo (todo lo que hay en la lista).
  const topLiquidez = arg("liquidez", 0);
  const capital = arg("capital", 1000);
  const soloLargos = process.argv.includes("--solo-largos");
  const cache = txt("cache");
  const desde = txt("desde");
  const hasta = txt("hasta");
  const tD = desde ? Date.parse(desde) / 1000 : 0;
  const tH = hasta ? Date.parse(hasta) / 1000 : Infinity;

  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = g[k];
      if (!v) continue;
      const f = v.filter((x) => x.t >= tD && x.t <= tH);
      if (f.length > 150) datos.set(k, f);
    }
  } else {
    for (const s of lista) {
      try {
        const v = (await velas(s, "1d")).filter((x) => x.t >= tD && x.t <= tH);
        if (v.length > 150) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }

  // El calendario de liquidez se calcula una vez, con volumen SOLO pasado.
  const calLiq = topLiquidez > 0
    ? calendarioUniverso(indexarPorFecha(datos), topLiquidez, 30, 30)
    : null;
  let fueraPorLiquidez = 0;

  const ops: Operacion[] = [];
  for (const [s, v] of datos) {
    const a = atr(v, 14);
    for (const sig of cfg.f(v, a)) {
      if (soloLargos && sig.direccion === "CORTO") continue;
      const av = a[sig.i];
      if (av == null || !(av > 0)) continue;
      if (calLiq && !estabaDentro(calLiq, s, v[sig.i]!.t)) {
        fueraPorLiquidez += 1;
        continue;
      }
      const stop = av * cfg.stop;
      const precio = v[sig.i]!.c;
      const coste = costeBps > 0 ? (precio * costeBps) / 10_000 : costeR * stop;
      // --sinhueco vuelve a la version optimista: cobra el nivel del stop aunque la vela abriera
      // ya pasada de el. Existe SOLO para medir cuanto valia esa suposicion.
      const r = simularRuptura(
        v, sig, stop, cfg.trail, coste / 2, 0, deslizR * stop, true,
        !process.argv.includes("--sinhueco"),
      );
      if (!r) continue;
      const iE = sig.i + 1;
      const iS = Math.min(iE + r.velas, v.length - 1);
      ops.push({
        instrumento: s, tEntrada: v[iE]!.t, tSalida: v[iS]!.t, r: r.r,
        direccion: sig.direccion,
        // El stop en fraccion del precio de entrada: sin esto no se sabe cuanto dinero mueve
        // la posicion, y una estrategia impagable parece rentable.
        stopFraccion: v[iE]!.o > 0 ? stop / v[iE]!.o : undefined,
      });
    }
  }
  if (ops.length === 0) {
    console.log("Sin operaciones.");
    return;
  }
  ops.sort((x, y) => x.tEntrada - y.tEntrada);
  const anios = (ops[ops.length - 1]!.tEntrada - ops[0]!.tEntrada) / (365.25 * 86400);

  console.log(
    `${datos.size} instrumentos · señal ${nombre} (stop ${cfg.stop} ATR, trailing ${cfg.trail}x)` +
      `${soloLargos ? " · SOLO LARGOS" : " · largos y cortos"}\n` +
      `${ops.length} operaciones en ${anios.toFixed(1)} años · coste ${(costeR * 100).toFixed(1)}% del riesgo\n`,
  );

  // ---- CONTROL: comprar y mantener todo a partes iguales -------------------------------
  let sumaMult = 0;
  let nBH = 0;
  for (const v of datos.values()) {
    const m = v[v.length - 1]!.c / v[0]!.c;
    if (Number.isFinite(m) && m > 0) {
      sumaMult += m;
      nBH += 1;
    }
  }
  const bhMult = nBH ? sumaMult / nBH : 1;
  const bhAnual = (Math.pow(bhMult, 1 / anios) - 1) * 100;

  console.log("CARTERA (riesgo compuesto, tope de posiciones simultaneas)");
  console.log(
    `${"tope".padStart(6)}${"acepta".padStart(9)}${"rechaza".padStart(9)}${"maxSim".padStart(8)}` +
      `${"final".padStart(13)}${"anual".padStart(9)}${"peor caida".padStart(12)}${"peor dia".padStart(10)}` +
      `${"expo max".padStart(10)}`,
  );
  console.log("-".repeat(86));
  for (const tope of [3, 5, 8, 12, 20, 0]) {
    for (const riesgo of [0.01]) {
      const r = simularCartera(ops, {
        capital, riesgoPct: riesgo, maxPosiciones: tope, compuesto: true,
        ...(maxExpo > 0 ? { maxExposicion: maxExpo } : {}),
      });
      const mult = r.capitalFinal / capital;
      const an = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
      console.log(
        `${(tope === 0 ? "sin" : String(tope)).padStart(6)}${String(r.aceptadas).padStart(9)}` +
          `${String(r.rechazadas).padStart(9)}${String(r.maxSimultaneas).padStart(8)}` +
          `${r.capitalFinal.toFixed(0).padStart(13)}${an.toFixed(1).padStart(8)}%` +
          `${(r.maxCaida * 100).toFixed(0).padStart(11)}%${(r.peorDia * 100).toFixed(0).padStart(9)}%` +
          `${r.maxExposicion.toFixed(1).padStart(9)}x`,
      );
    }
  }

  // ---- OBJETIVO DE VOLATILIDAD ---------------------------------------------------------
  // El tamaño deja de ser fijo y se escala con la volatilidad reciente de los resultados. Es el
  // estandar en managed futures y ataca la sobre-apuesta, que es lo que medimos como causa de
  // las caidas grandes.
  console.log("\nOBJETIVO DE VOLATILIDAD (tope 8 posiciones, riesgo base 1%)");
  console.log(
    `${"objetivo".padStart(10)}${"final".padStart(13)}${"anual".padStart(9)}` +
      `${"peor caida".padStart(12)}${"peor dia".padStart(10)}${"ratio".padStart(8)}`,
  );
  console.log("-".repeat(62));
  for (const ov of [0, 0.3, 0.5, 0.8, 1.2]) {
    const r = simularCartera(ops, {
      capital, riesgoPct: 0.01, maxPosiciones: 8, compuesto: true,
      ...(ov > 0 ? { objetivoVol: ov, ventanaVol: 30, maxEscala: 3 } : {}),
    });
    const mult = r.capitalFinal / capital;
    const an = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
    console.log(
      `${(ov === 0 ? "fijo" : ov.toFixed(1)).padStart(10)}${r.capitalFinal.toFixed(0).padStart(13)}` +
        `${an.toFixed(1).padStart(8)}%${(r.maxCaida * 100).toFixed(0).padStart(11)}%` +
        `${(r.peorDia * 100).toFixed(0).padStart(9)}%` +
        `${(an / (r.maxCaida * 100 || 1)).toFixed(2).padStart(8)}`,
    );
  }

  // ---- TOPE POR DIRECCION: la prueba de si la correlacion es el problema ----------------
  // Limitar el total no basta con instrumentos correlacionados: 8 largos en 8 criptos no son
  // 8 apuestas, son una repetida 8 veces. Esto mide cuanto de la caida venia de ahi.
  console.log("\nTOPE POR DIRECCION (total 8 posiciones, riesgo 1%)");
  console.log(
    `${"max/lado".padStart(9)}${"acepta".padStart(9)}${"final".padStart(13)}${"anual".padStart(9)}` +
      `${"peor caida".padStart(12)}${"peor dia".padStart(10)}${"ratio".padStart(8)}`,
  );
  console.log("-".repeat(70));
  for (const md of [1, 2, 3, 4, 8]) {
    const r = simularCartera(ops, {
      capital, riesgoPct: 0.01, maxPosiciones: 8, maxPorDireccion: md, compuesto: true,
    });
    const mult = r.capitalFinal / capital;
    const an = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
    console.log(
      `${String(md).padStart(9)}${String(r.aceptadas).padStart(9)}` +
        `${r.capitalFinal.toFixed(0).padStart(13)}${an.toFixed(1).padStart(8)}%` +
        `${(r.maxCaida * 100).toFixed(0).padStart(11)}%${(r.peorDia * 100).toFixed(0).padStart(9)}%` +
        `${(an / (r.maxCaida * 100 || 1)).toFixed(2).padStart(8)}`,
    );
  }

  console.log("\nRIESGO POR OPERACION (tope de 8 posiciones)");
  console.log(
    `${"riesgo".padStart(8)}${"final".padStart(13)}${"anual".padStart(9)}${"peor caida".padStart(12)}${"peor dia".padStart(10)}`,
  );
  console.log("-".repeat(52));
  // Riesgos muy pequeños incluidos a proposito: cuando una estrategia gana MAS con menos
  // riesgo, esta sobre-apostando y el optimo esta por debajo de todo lo probado.
  for (const rp of [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.02]) {
    const r = simularCartera(ops, { capital, riesgoPct: rp, maxPosiciones: 8, compuesto: true });
    const mult = r.capitalFinal / capital;
    const an = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
    console.log(
      `${(rp * 100).toFixed(2).padStart(7)}%${r.capitalFinal.toFixed(0).padStart(13)}` +
        `${an.toFixed(1).padStart(8)}%${(r.maxCaida * 100).toFixed(0).padStart(11)}%` +
        `${(r.peorDia * 100).toFixed(0).padStart(9)}%`,
    );
  }

  console.log(
    `\nCONTROL comprar y mantener todo a partes iguales: ${bhAnual.toFixed(1)}% anual (${bhMult.toFixed(1)}x).`,
  );

  // ---- AÑO A AÑO -----------------------------------------------------------------------
  console.log("\nAÑO A AÑO en R");
  const porAnio = new Map<string, number[]>();
  for (const o of ops) {
    const y = new Date(o.tEntrada * 1000).toISOString().slice(0, 4);
    const l = porAnio.get(y);
    if (l) l.push(o.r);
    else porAnio.set(y, [o.r]);
  }
  let perdedores = 0;
  const anosOrd = [...porAnio.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [y, rs] of anosOrd) {
    const total = rs.reduce((s, x) => s + x, 0);
    if (total <= 0) perdedores += 1;
    const g = rs.filter((x) => x > 0).length;
    console.log(
      `   ${y}${String(rs.length).padStart(6)} ops${((g / rs.length) * 100).toFixed(0).padStart(5)}%` +
        `${(total >= 0 ? "+" : "") + total.toFixed(1)}R`.padStart(11),
    );
  }
  console.log(`\n   ${perdedores} de ${anosOrd.length} años en perdidas.`);
  console.log(`   Frecuencia: ${(ops.length / anios).toFixed(0)} operaciones al año.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
