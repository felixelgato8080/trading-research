/**
 * Seguimiento de tendencia sobre un universo de futuros y materias primas.
 *
 *   npm run futuros -- --lista futuros_ok.json [--coste=0.02] [--desde=...] [--hasta=...]
 *
 * POR QUE AQUI
 * ------------
 * En forex intradia el coste se come entre el 10% y el 70% del riesgo, y ese fue el muro
 * contra el que chocaron cinco familias de estrategias. En futuros diarios el coste ronda el
 * 1-2% del riesgo: comision y deslizamiento son pequeños frente a un rango diario.
 *
 * No es una corazonada: es la misma estrategia con el peaje dividido por veinte.
 *
 * EL COSTE VA EN FRACCION DEL RIESGO, no en pips. Un pip no significa lo mismo en el maiz que
 * en el bitcoin, y expresarlo en R hace comparables instrumentos de escalas completamente
 * distintas. Se prueban varios niveles porque el coste real depende del broker.
 *
 * Mismas defensas que han tumbado seis hallazgos antes: fuera de muestra, quitar el mejor
 * instrumento, y decir cuantas combinaciones se han probado.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { canal, volatilidad, simularRuptura, type SeñalRuptura } from "../forex/rupturas";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

interface Variante {
  nombre: string;
  señales: (v: Vela[], a: (number | null)[]) => SeñalRuptura[];
  atrStop: number;
  trailing: number;
}

interface Fila {
  nombre: string;
  n: number;
  wr: number;
  pf: number;
  exp: number;
  rGana: number;
  rPierde: number;
  maxDD: number;
  sinMejor: number;
  enVerde: number;
  total: number;
}

function evaluar(nombre: string, porInstr: Map<string, number[]>): Fila | null {
  const todas = [...porInstr.values()].flat();
  // 60 operaciones es poco, pero en una ventana de dos años no da para mas y peor es no mirar.
  if (todas.length < 60) return null;

  const g = todas.filter((x) => x > 0);
  const p = todas.filter((x) => x <= 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -p.reduce((s, x) => s + x, 0);

  let pico = 0, acum = 0, maxDD = 0;
  for (const r of todas) {
    acum += r;
    pico = Math.max(pico, acum);
    maxDD = Math.max(maxDD, pico - acum);
  }

  const mejor = [...porInstr.entries()].sort(
    (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
  )[0]?.[0];
  const sm = [...porInstr.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);

  return {
    nombre,
    n: todas.length,
    wr: g.length / todas.length,
    pf: sp > 0 ? sg / sp : 0,
    exp: todas.reduce((s, x) => s + x, 0) / todas.length,
    rGana: g.length ? sg / g.length : 0,
    rPierde: p.length ? -sp / p.length : 0,
    maxDD,
    sinMejor: sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0,
    // Cuantos instrumentos aportan en positivo: con 28, que ganen 5 no es una estrategia.
    enVerde: [...porInstr.values()].filter((l) => l.length > 10 && l.reduce((s, x) => s + x, 0) > 0).length,
    total: porInstr.size,
  };
}

async function main(): Promise<void> {
  const costeR = arg("coste", 0.02);
  // COSTE EN PUNTOS BASICOS DEL PRECIO. Es lo correcto: comision y spread son fijos en
  // precio, no proporcionales al stop que uno elija. Poner un stop mas ancho no hace que el
  // broker cobre mas. Con `--coste` (fraccion del riesgo) una estrategia de stop ancho paga
  // en dinero real mucho mas que una de stop estrecho, que es un sesgo que no queriamos.
  // 0 = usar el modo antiguo.
  const costeBps = arg("costebps", 0);
  // Mide cuanto pesa la regla dura de contar el stop ya en la vela de entrada.
  const optimista = process.argv.includes("--optimista");
  const desde = process.argv.find((a) => a.startsWith("--desde="))?.split("=")[1];
  const hasta = process.argv.find((a) => a.startsWith("--hasta="))?.split("=")[1];
  const tD = desde ? Date.parse(desde) / 1000 : 0;
  const tH = hasta ? Date.parse(hasta) / 1000 : Infinity;

  // Con una cuenta pequeña y en efectivo, ponerse corto suele no estar disponible: hace falta
  // margen y prestamo de titulos. Si la ventaja solo existe con cortos, no es utilizable.
  const soloLargos = process.argv.includes("--solo-largos");
  if (soloLargos) console.log("SOLO LARGOS: sin ventas en corto\n");

  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  console.log(
    `${lista.length} instrumentos · coste ${(costeR * 100).toFixed(1)}% del riesgo · ` +
      `${desde ?? "inicio"} a ${hasta ?? "hoy"}\n`,
  );

  const cache = process.argv.find((a) => a.startsWith("--cache="))?.split("=")[1];
  const datos = new Map<string, Vela[]>();
  // 150 velas = medio año. Ventanas cortas hacen falta para aislar tramos bajistas, que es
  // donde se distingue una ventaja real de haber estado largo en un mercado alcista.
  if (cache && existsSync(cache)) {
    const guardado = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    // La cache puede tener MAS instrumentos que la lista pedida. Filtrar por la lista no es un
    // detalle: sin esto, pedir un subconjunto devolvia el universo entero y las comparaciones
    // entre subconjuntos salian identicas.
    for (const k of lista) {
      const v = guardado[k];
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
  console.log(`${datos.size} con datos suficientes\n`);

  // Elegidas de antemano. Se reporta el numero.
  const variantes: Variante[] = [
    { nombre: "canal 20 · trail 2x", señales: (v) => canal(v, 20), atrStop: 2, trailing: 2 },
    { nombre: "canal 20 · trail 3x", señales: (v) => canal(v, 20), atrStop: 2, trailing: 3 },
    { nombre: "canal 50 · trail 2x", señales: (v) => canal(v, 50), atrStop: 2, trailing: 2 },
    { nombre: "canal 50 · trail 3x", señales: (v) => canal(v, 50), atrStop: 2, trailing: 3 },
    { nombre: "canal 100 · trail 3x", señales: (v) => canal(v, 100), atrStop: 2, trailing: 3 },
    { nombre: "canal 20 · stop 3 ATR", señales: (v) => canal(v, 20), atrStop: 3, trailing: 2 },
    { nombre: "canal 50 · stop 3 ATR", señales: (v) => canal(v, 50), atrStop: 3, trailing: 3 },
    { nombre: "canal 20 · sin techo", señales: (v) => canal(v, 20), atrStop: 2, trailing: 0 },
    { nombre: "volatilidad 2 ATR", señales: (v, a) => volatilidad(v, a, 2), atrStop: 2, trailing: 2 },
    { nombre: "volatilidad 3 ATR", señales: (v, a) => volatilidad(v, a, 3), atrStop: 2, trailing: 2 },
  ];

  // Vecindario denso alrededor de la ruptura de volatilidad. El spec exige distinguir un punto
  // afortunado de una familia entera que funciona: si solo gana un valor exacto y sus vecinos
  // pierden, es sobreajuste.
  if (process.argv.includes("--vecindario")) {
    const rejilla: Variante[] = [];
    for (const k of [1, 1.5, 2, 2.5, 3, 4]) {
      for (const st of [1.5, 2, 3]) {
        rejilla.push({
          nombre: `vol ${k} ATR · stop ${st}`,
          señales: (v, a) => volatilidad(v, a, k),
          atrStop: st,
          trailing: 2,
        });
      }
    }
    variantes.length = 0;
    variantes.push(...rejilla);
  }

  console.log(
    `${"variante".padEnd(24)}${"ops".padStart(7)}${"WR".padStart(6)}${"PF".padStart(7)}` +
      `${"exp R".padStart(9)}${"Rgana".padStart(8)}${"Rpierde".padStart(9)}` +
      `${"maxDD".padStart(8)}${"sin mejor".padStart(11)}${"en verde".padStart(11)}`,
  );
  console.log("-".repeat(100));

  const filas: Fila[] = [];
  for (const va of variantes) {
    const porInstr = new Map<string, number[]>();
    for (const [s, v] of datos) {
      const a = atr(v, 14);
      const rs: number[] = [];
      for (const sig of va.señales(v, a)) {
        if (soloLargos && sig.direccion === "CORTO") continue;
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const stop = av * va.atrStop;
        // En puntos basicos el coste sale del PRECIO; en el modo antiguo, del stop.
        const precio = v[sig.i]!.c;
        const coste = costeBps > 0 ? (precio * costeBps) / 10_000 : costeR * stop;
        const r = simularRuptura(v, sig, stop, va.trailing, coste / 2, 0, 0, !optimista);
        if (r) rs.push(r.r);
      }
      porInstr.set(s, rs);
    }
    const f = evaluar(va.nombre, porInstr);
    if (!f) {
      console.log(`${va.nombre.padEnd(24)}   (muestra corta)`);
      continue;
    }
    filas.push(f);
    console.log(
      `${f.nombre.padEnd(24)}${String(f.n).padStart(7)}${(f.wr * 100).toFixed(0).padStart(5)}%` +
        `${f.pf.toFixed(2).padStart(7)}${f.exp.toFixed(3).padStart(9)}` +
        `${f.rGana.toFixed(2).padStart(8)}${f.rPierde.toFixed(2).padStart(9)}` +
        `${f.maxDD.toFixed(0).padStart(8)}${f.sinMejor.toFixed(3).padStart(11)}` +
        `${(f.enVerde + "/" + f.total).padStart(11)}`,
    );
  }

  console.log("-".repeat(100));
  const buenas = filas.filter((f) => f.sinMejor > 0).sort((a, b) => b.sinMejor - a.sinMejor);
  if (buenas.length === 0) {
    console.log("Ninguna variante queda positiva tras quitarle su mejor instrumento.");
  } else {
    console.log("Positivas incluso sin su mejor instrumento:");
    for (const f of buenas) {
      console.log(
        `  ${f.nombre.padEnd(24)} PF ${f.pf.toFixed(2)} · ${f.sinMejor.toFixed(3)}R · ` +
          `WR ${(f.wr * 100).toFixed(0)}% · ganadora ${f.rGana.toFixed(1)}R vs ${f.rPierde.toFixed(1)}R · ` +
          `${f.enVerde}/${f.total} instrumentos`,
      );
    }
  }
  console.log(`\nCombinaciones probadas: ${variantes.length}.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
