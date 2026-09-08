/**
 * ¿De donde salen los pips? Distribucion de resultados, no tasa de acierto.
 *
 *   npm run fx:dist -- [--tf=1h] [--spread=0]
 *
 * LA PREGUNTA
 * -----------
 * Contar cuantas operaciones ganan y pierden esconde lo que importa: el TAMAÑO. Una estrategia
 * con 34% de acierto puede ser mejor que una con 70% si sus ganadoras son grandes.
 *
 * Y hay un sesgo que yo mismo estaba metiendo: con objetivo fijo (1:1, 2:1) se le pone TECHO a
 * las ganadoras. Si el borde vive en la cola —que es lo normal en series financieras— cortarla
 * es matar justo lo que paga. Aqui se prueban salidas SIN techo: solo stop, o stop movil.
 *
 * Se mide sobre 28 pares para tener muestra de verdad.
 */
import { velas, pip, type Vela } from "../forex/datos";
import { rsi, señales, type ReglasRsi } from "../forex/rsi";
import { atr } from "../forex/multiTf";
import type { Señal } from "../forex/rsi";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

/**
 * Simulacion con stop movil y SIN objetivo: la ganadora corre hasta que el precio se gira.
 * Devuelve el resultado en R.
 *
 * Es la variante que faltaba: con objetivo fijo nunca se ve cuanto habrian dado las mejores.
 */
function simularSinTecho(
  v: Vela[],
  ss: Señal[],
  stopPips: number,
  trailing: number,
  spreadPips: number,
  pipTam: number,
  atrValores?: (number | null)[],
  atrMult = 0,
): number[] {
  const out: number[] = [];
  const spread = spreadPips * pipTam;

  for (const s of ss) {
    const i0 = s.i + 1;
    if (i0 >= v.length) continue;

    let stop = stopPips * pipTam;
    if (atrMult && atrValores) {
      const a = atrValores[s.i];
      if (a == null || !(a > 0)) continue;
      stop = a * atrMult;
    }

    const largo = s.direccion === "LARGO";
    const entrada = v[i0]!.o + (largo ? spread : -spread);
    // El stop movil arranca en el stop inicial y solo se mueve a favor, nunca en contra.
    let nivel = largo ? entrada - stop : entrada + stop;
    let extremo = entrada;
    let salida: number | null = null;

    for (let j = i0; j < v.length; j += 1) {
      const c = v[j]!;
      if (largo ? c.l <= nivel : c.h >= nivel) {
        salida = nivel;
        break;
      }
      if (largo) {
        if (c.h > extremo) extremo = c.h;
        // trailing = 0 significa stop fijo: la ganadora corre sin limite hasta que se gira.
        if (trailing > 0) nivel = Math.max(nivel, extremo - stop * trailing);
      } else {
        if (c.l < extremo) extremo = c.l;
        if (trailing > 0) nivel = Math.min(nivel, extremo + stop * trailing);
      }
    }
    if (salida === null) salida = v[v.length - 1]!.c;

    const neta = salida - (largo ? spread : -spread);
    out.push((largo ? neta - entrada : entrada - neta) / stop);
  }
  return out;
}

function percentil(o: number[], f: number): number {
  if (!o.length) return 0;
  return o[Math.min(o.length - 1, Math.floor(o.length * f))]!;
}

/** De donde sale el resultado: ¿de muchas medianas o de unas pocas enormes? */
function informeDistribucion(
  nombre: string,
  rs: number[],
  mediaSinMejor: number,
  paresEnVerde: number,
  paresTotal: number,
): void {
  if (rs.length < 50) {
    console.log(`${nombre.padEnd(26)} (muestra corta: ${rs.length})`);
    return;
  }
  const o = [...rs].sort((a, b) => a - b);
  const total = rs.reduce((s, x) => s + x, 0);
  const media = total / rs.length;
  const ganadoras = rs.filter((x) => x > 0);
  const perdedoras = rs.filter((x) => x <= 0);
  const sumaG = ganadoras.reduce((s, x) => s + x, 0);
  const sumaP = -perdedoras.reduce((s, x) => s + x, 0);

  // Cuanto aporta el 10% mejor. Si es casi todo, el resultado depende de la cola.
  const top10 = o.slice(Math.floor(o.length * 0.9)).reduce((s, x) => s + x, 0);

  console.log(
    `${nombre.padEnd(26)}${String(rs.length).padStart(7)}` +
      `${((ganadoras.length / rs.length) * 100).toFixed(0).padStart(7)}%` +
      `${media.toFixed(4).padStart(10)}` +
      `${(sumaP > 0 ? sumaG / sumaP : 0).toFixed(2).padStart(9)}` +
      `${(ganadoras.length ? sumaG / ganadoras.length : 0).toFixed(2).padStart(9)}` +
      `${(perdedoras.length ? -sumaP / perdedoras.length : 0).toFixed(2).padStart(9)}` +
      `${mediaSinMejor.toFixed(4).padStart(11)}` +
      `${(paresEnVerde + "/" + paresTotal).padStart(9)}` +
      `${percentil(o, 0.99).toFixed(1).padStart(8)}`,
  );
}

async function main(): Promise<void> {
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ?? "1h") as any;
  const spreadPips = arg("spread", 0);
  const stopPips = arg("stop", 40);

  const pares: string[] = JSON.parse(
    require("node:fs").readFileSync(process.argv[process.argv.indexOf("--pares") + 1] ?? "", "utf-8"),
  );
  console.log(`${pares.length} pares · ${tf} · spread ${spreadPips} pips\n`);

  // Corte por fecha, para partir el periodo y probar fuera de muestra. Es la prueba que ha
  // tumbado todas las variantes anteriores, asi que se aplica antes de creerse nada.
  const desde = process.argv.find((a) => a.startsWith("--desde="))?.split("=")[1];
  const hasta = process.argv.find((a) => a.startsWith("--hasta="))?.split("=")[1];
  const tDesde = desde ? Date.parse(desde) / 1000 : 0;
  const tHasta = hasta ? Date.parse(hasta) / 1000 : Infinity;
  if (desde || hasta) console.log(`periodo: ${desde ?? "inicio"} a ${hasta ?? "hoy"}
`);

  const datos = new Map<string, Vela[]>();
  for (const p of pares) {
    try {
      const v = (await velas(p, tf)).filter((x) => x.t >= tDesde && x.t <= tHasta);
      if (v.length > 500) datos.set(p, v);
    } catch {
      /* se salta */
    }
    await dormir(500);
  }
  console.log(`${datos.size} pares con datos\n`);

  const base: ReglasRsi = { periodo: 14, sobreventa: 30, sobrecompra: 70, esperarCruce: true };

  const variantes: Array<[string, number, number, number]> = [
    // nombre, trailing (0 = stop fijo, sin techo), atrMult (0 = pips fijos), stopPips
    ["stop fijo, SIN techo", 0, 0, stopPips],
    ["trailing 1x stop", 1, 0, stopPips],
    ["trailing 2x stop", 2, 0, stopPips],
    ["trailing 3x stop", 3, 0, stopPips],
    ["ATR2 sin techo", 0, 2, 0],
    ["ATR2 + trailing 2x", 2, 2, 0],
  ];

  console.log(
    `${"variante".padEnd(26)}${"ops".padStart(7)}${"gana".padStart(8)}${"R media".padStart(10)}` +
      `${"PF".padStart(9)}${"R gana".padStart(9)}${"R pierde".padStart(9)}${"sin mejor".padStart(11)}${"pares+".padStart(9)}${"p99".padStart(8)}`,
  );
  console.log("-".repeat(96));

  for (const [nombre, trailing, atrMult, sp] of variantes) {
    const porPar = new Map<string, number[]>();
    for (const [par, v] of datos) {
      const ss = señales(v.map((x) => x.c), base);
      const av = atrMult ? atr(v, 14) : undefined;
      porPar.set(
        par,
        simularSinTecho(v, ss, sp || stopPips, trailing, spreadPips, (pip(par) ?? 0.0001), av, atrMult),
      );
    }
    const todas = [...porPar.values()].flat();

    // Quitarle su mejor par: la prueba que separa estrategia de casualidad. Con 28 pares es
    // mas exigente que con 5, porque quitar uno apenas cambia la muestra.
    const mejor = [...porPar.entries()].sort(
      (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
    )[0]?.[0];
    const sm = [...porPar.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    const mediaSin = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;
    // Cuantos pares aportan en positivo: si son 5 de 28, no hay estrategia.
    const enVerde = [...porPar.values()].filter(
      (l) => l.length > 20 && l.reduce((s, x) => s + x, 0) > 0,
    ).length;

    informeDistribucion(nombre, todas, mediaSin, enVerde, porPar.size);
  }

  console.log("-".repeat(96));
  console.log(
    "PF = pips ganados / pips perdidos. Es la medida que pediste: mira el TAMAÑO, no la\n" +
      "frecuencia. PF>1 significa que se ganan mas pips de los que se pierden, aunque se\n" +
      "acierte menos de la mitad de las veces.\n" +
      "top10% = cuanto del resultado total aporta el 10% mejor de las operaciones.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
