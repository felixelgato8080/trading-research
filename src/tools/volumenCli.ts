/**
 * Las estrategias con VOLUMEN que faltaban por medir.
 *
 *   npm run volumen -- --lista X.json [--tf=1h] [--coste=0.03] [--cache=v.json]
 *
 * Tres preguntas, todas con su control:
 *
 *   1. VWAP: el retroceso al VWAP, ¿supera a entrar al azar con el mismo stop y objetivo?
 *   2. RUPTURA CON VOLUMEN: la ruptura de volatilidad ya medida (PF 1,54 en cripto diario),
 *      ¿mejora si se exige pico de volumen? Es la pregunta accionable, porque hay una
 *      estrategia funcionando a la que solo habria que añadirle el filtro.
 *   3. HUECOS: el articulo dice "verifica siempre el volumen, los huecos flojos no son fiables".
 *      Se mide con y sin esa verificacion para ver si el consejo vale algo.
 *
 * Antes de nada se comprueba la COBERTURA de volumen: en forex es cero y medir alli seria medir
 * ceros y concluir que el volumen no sirve.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela, type Temporalidad } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { evaluarPorRiesgo, informe } from "../forex/controles";
import { volatilidad, simularRuptura } from "../forex/rupturas";
import { simularObjetivo, type SeñalTdfi } from "../forex/tdfi";
import {
  coberturaVolumen, vwap, picoVolumen, retornoAlVwap, huecos,
} from "../forex/volumen";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}
function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface M { n: number; wr: number; pf: number; exp: number }
function medir(rs: number[]): M {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0 };
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return {
    n: rs.length, wr: g.length / rs.length, pf: sp > 0 ? sg / sp : 0,
    exp: rs.reduce((s, x) => s + x, 0) / rs.length,
  };
}
function fila(nombre: string, m: M): string {
  return (
    `${nombre.padEnd(34)}${String(m.n).padStart(8)}${(m.wr * 100).toFixed(1).padStart(8)}%` +
    `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(4).padStart(10)}`
  );
}
const CAB =
  `${"variante".padEnd(34)}${"ops".padStart(8)}${"acierto".padStart(9)}${"PF".padStart(7)}${"exp R".padStart(10)}`;

async function main(): Promise<void> {
  const tf = (txt("tf") ?? "1h") as Temporalidad;
  const costeR = num("coste", 0.03);
  const cache = txt("cache");
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = g[k];
      if (v && v.length > 300) datos.set(k, v);
    }
  } else {
    for (const s of lista) {
      try {
        const v = await velas(s, tf);
        if (v.length > 300) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }

  // ---- COBERTURA: sin esto, todo lo demas mide ceros ------------------------------------
  const cobertura = new Map<string, number>();
  for (const [s, v] of datos) cobertura.set(s, coberturaVolumen(v));
  const conVolumen = [...cobertura.entries()].filter(([, c]) => c > 0.5).map(([s]) => s);
  const media = [...cobertura.values()].reduce((a, b) => a + b, 0) / (cobertura.size || 1);

  const etiqueta = cache && existsSync(cache) ? `cache ${cache.split("/").pop()}` : tf;
  console.log(`${datos.size} instrumentos · ${etiqueta} · coste ${(costeR * 100).toFixed(1)}% del riesgo`);
  console.log(
    `COBERTURA DE VOLUMEN: ${(media * 100).toFixed(0)}% de las velas · ` +
      `${conVolumen.length} de ${datos.size} instrumentos utilizables\n`,
  );
  if (conVolumen.length === 0) {
    console.log("Ningun instrumento trae volumen. Aqui no hay nada que medir: en forex al contado");
    console.log("no existe volumen central y Yahoo devuelve ceros. Prueba con cripto o ETFs.");
    return;
  }
  const utiles = new Map([...datos].filter(([s]) => conVolumen.includes(s)));

  // ---- 1. VWAP -------------------------------------------------------------------------
  console.log("1. VWAP: retroceso al VWAP tras sostenerse a un lado");
  console.log(CAB);
  console.log("-".repeat(67));

  let mejorVwap: { objetivo: number; confirmacion: number; exp: number } | null = null;
  for (const objetivo of [1, 2]) {
    for (const confirmacion of [2, 3]) {
      const res: number[] = [];
      const ctrl: number[] = [];
      const rnd = azar(999 + objetivo * 10 + confirmacion);
      for (const [, v] of utiles) {
        const a = atr(v, 14);
        const w = vwap(v);
        const sen = retornoAlVwap(v, w, confirmacion);
        for (const s of sen) {
          const av = a[s.i];
          if (av == null || !(av > 0)) continue;
          const señal: SeñalTdfi = { i: s.i, direccion: s.direccion, riesgo: av * 1.5 };
          const r = simularObjetivo(v, señal, objetivo, costeR * señal.riesgo, 0, true);
          if (r) res.push(r.r);
        }
        // Control: mismas velas, mismo stop, misma cantidad, entrada y direccion al azar.
        for (let k = 0; k < sen.length; k += 1) {
          const i = 50 + Math.floor(rnd() * (v.length - 60));
          const av = a[i];
          if (av == null || !(av > 0)) continue;
          const falsa: SeñalTdfi = {
            i, direccion: rnd() < 0.5 ? "LARGO" : "CORTO", riesgo: av * 1.5,
          };
          const r = simularObjetivo(v, falsa, objetivo, costeR * falsa.riesgo, 0, true);
          if (r) ctrl.push(r.r);
        }
      }
      const m = medir(res);
      console.log(fila(`VWAP ${confirmacion} velas · objetivo ${objetivo}R`, m));
      console.log(fila(`  AZAR · objetivo ${objetivo}R`, medir(ctrl)));
      if (m.n > 30 && (!mejorVwap || m.exp > mejorVwap.exp)) {
        mejorVwap = { objetivo, confirmacion, exp: m.exp };
      }
    }
  }

  // ---- LA BATERIA ENTERA sobre la mejor variante del VWAP --------------------------------
  //
  // Arriba solo habia UN control, el de entradas al azar. Faltaban los otros tres, y cada uno
  // contesta algo que el del azar no puede: si aporta acertar el LADO, si se sostiene en las dos
  // mitades del calendario, y si depende de un solo instrumento.
  //
  // Se corre sobre la MEJOR de las cuatro variantes a proposito. Es la que uno se quedaria, o
  // sea la que ya viene elegida por haber mirado los resultados, y por eso es justo la que hay
  // que apretar. Si la mejor de cuatro no aguanta la bateria, ninguna aguanta.
  //
  if (mejorVwap) {
    const { objetivo, confirmacion } = mejorVwap;
    console.log(
      `
LA BATERIA ENTERA sobre la mejor variante: ${confirmacion} velas · objetivo ${objetivo}R`,
    );
    console.log(
      informe(evaluarPorRiesgo(
        utiles,
        (v) => atr(v, 14),
        (_par, v) => {
          const a = atr(v, 14);
          const w = vwap(v);
          const out: SeñalTdfi[] = [];
          for (const x of retornoAlVwap(v, w, confirmacion)) {
            const av = a[x.i];
            if (av == null || !(av > 0)) continue;
            out.push({ i: x.i, direccion: x.direccion, riesgo: av * 1.5 });
          }
          return out;
        },
        objetivo,
        (v, x, objetivoR) => simularObjetivo(v, x, objetivoR, costeR * x.riesgo, 0, true),
      )),
    );
  }

  // ---- 2. LA PREGUNTA ACCIONABLE: ¿mejora la ruptura que YA funciona? -------------------
  console.log("\n2. RUPTURA DE VOLATILIDAD (la que ya funciona) CON Y SIN filtro de volumen");
  console.log(CAB);
  console.log("-".repeat(67));

  for (const k of [2, 3]) {
    for (const exigir of [false, true]) {
      for (const mult of exigir ? [1.5, 2] : [0]) {
        const res: number[] = [];
        for (const [, v] of utiles) {
          const a = atr(v, 14);
          const pico = picoVolumen(v, 20, mult);
          for (const s of volatilidad(v, a, k)) {
            if (exigir && !pico[s.i]) continue;
            const av = a[s.i];
            if (av == null || !(av > 0)) continue;
            const stop = av * 2;
            const r = simularRuptura(v, s, stop, 2, (costeR * stop) / 2, 0);
            if (r) res.push(r.r);
          }
        }
        console.log(
          fila(exigir ? `  vol ${k} ATR + volumen x${mult}` : `vol ${k} ATR · SIN filtro`, medir(res)),
        );
      }
    }
  }

  // ---- 3. HUECOS: ¿vale algo el consejo del articulo? -----------------------------------
  console.log("\n3. HUECOS DE APERTURA, continuacion (con y sin verificar volumen)");
  console.log(CAB);
  console.log("-".repeat(67));

  for (const minimo of [0.01, 0.02]) {
    for (const exigir of [false, true]) {
      const res: number[] = [];
      for (const [, v] of utiles) {
        const a = atr(v, 14);
        for (const g of huecos(v, minimo, exigir)) {
          const av = a[g.i];
          if (av == null || !(av > 0)) continue;
          const señal: SeñalTdfi = { i: g.i, direccion: g.direccion, riesgo: av * 1.5 };
          const r = simularObjetivo(v, señal, 1.5, costeR * señal.riesgo, 0, true);
          if (r) res.push(r.r);
        }
      }
      console.log(
        fila(`hueco ${(minimo * 100).toFixed(0)}%${exigir ? " + volumen" : " · sin verificar"}`, medir(res)),
      );
    }
  }

  // ---- 4. ¿ES REAL LA MEJORA DEL FILTRO DE VOLUMEN? ------------------------------------
  // El filtro se queda con un SUBCONJUNTO de las operaciones. Que ese subconjunto salga mejor
  // puede ser seleccion afortunada, asi que hay que exigirle lo mismo que a cualquier hallazgo:
  // que aguante en las dos mitades del calendario, sin su mejor instrumento, y en la mayoria.
  console.log("\n4. ¿AGUANTA EL FILTRO DE VOLUMEN LAS PRUEBAS DE SIEMPRE?");

  const todosT = [...utiles.values()].flatMap((v) => [v[0]!.t, v[v.length - 1]!.t]);
  const corte = (Math.min(...todosT) + Math.max(...todosT)) / 2;
  const fecha = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

  console.log(
    `${"variante".padEnd(28)}${"ops".padStart(7)}${"PF".padStart(7)}${"exp R".padStart(9)}` +
      `${"1a mitad".padStart(10)}${"2a mitad".padStart(10)}${"sin mejor".padStart(11)}${"mejoran".padStart(9)}`,
  );
  console.log(`corte fuera de muestra: ${fecha(corte)}`);
  console.log("-".repeat(91));

  const sinFiltro = new Map<string, number>();
  for (const mult of [0, 1.5, 2, 3]) {
    const porInstr = new Map<string, number[]>();
    const mA: number[] = [];
    const mB: number[] = [];
    for (const [nombre, v] of utiles) {
      const a = atr(v, 14);
      const pico = picoVolumen(v, 20, mult);
      const rs: number[] = [];
      for (const sig of volatilidad(v, a, 2)) {
        if (mult > 0 && !pico[sig.i]) continue;
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const stop = av * 2;
        const r = simularRuptura(v, sig, stop, 2, (costeR * stop) / 2, 0);
        if (!r) continue;
        rs.push(r.r);
        (v[sig.i]!.t < corte ? mA : mB).push(r.r);
      }
      porInstr.set(nombre, rs);
      if (mult === 0 && rs.length) {
        sinFiltro.set(nombre, rs.reduce((x, y) => x + y, 0) / rs.length);
      }
    }

    const todas = [...porInstr.values()].flat();
    const m = medir(todas);
    const mejor = [...porInstr.entries()].sort(
      (x, y) => y[1].reduce((s, k) => s + k, 0) - x[1].reduce((s, k) => s + k, 0),
    )[0]?.[0];
    const sm = [...porInstr.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    const sinMejor = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;

    // Cuantos instrumentos MEJORAN respecto a no filtrar. Es la prueba de amplitud: si el filtro
    // solo ayuda en tres monedas, no es un filtro, es una casualidad.
    let mejoran = 0;
    let comparables = 0;
    if (mult > 0) {
      for (const [nombre, rs] of porInstr) {
        const base = sinFiltro.get(nombre);
        if (base == null || rs.length < 10) continue;
        comparables += 1;
        if (rs.reduce((s, x) => s + x, 0) / rs.length > base) mejoran += 1;
      }
    }

    console.log(
      `${(mult === 0 ? "sin filtro" : `volumen x${mult}`).padEnd(28)}${String(m.n).padStart(7)}` +
        `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(3).padStart(9)}` +
        `${medir(mA).exp.toFixed(3).padStart(10)}${medir(mB).exp.toFixed(3).padStart(10)}` +
        `${sinMejor.toFixed(3).padStart(11)}` +
        `${(mult === 0 ? "-" : `${mejoran}/${comparables}`).padStart(9)}`,
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
