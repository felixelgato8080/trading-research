/**
 * ¿Merece la pena piramidar sobre las ganadoras?
 *
 *   npm run piramide -- --lista L.json --cache=V.json [--costebps=10]
 *
 * LA COMPARACION HONESTA ES A RIESGO IGUALADO
 * -------------------------------------------
 * Tres unidades al 1% son el TRIPLE de riesgo que una. Comparar retornos sin normalizar siempre
 * dara que piramidar gana, porque subir el riesgo siempre sube el retorno; con esa logica la
 * conclusion seria "arriesga mas", que no hace falta medir.
 *
 * Aqui cada configuracion se corre con el riesgo por unidad DIVIDIDO entre el maximo de unidades,
 * de modo que el riesgo comprometido en el peor momento es el mismo en todas. Asi la pregunta
 * pasa a ser la que importa: con el mismo riesgo maximo, ¿reparte mejor el dinero piramidar o
 * poner todo de una vez?
 *
 * Y ADEMAS SE MIRA SI CAEN JUNTAS
 * -------------------------------
 * Piramidar concentra: las unidades estan en el mismo instrumento y la misma direccion, asi que
 * un giro las mata a la vez. El retorno medio no lo enseña; la peor caida y las perdidas
 * simultaneas si.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { volatilidad } from "../forex/rupturas";
import { simular, type AjustesPiramide } from "../forex/piramide";
import { simularCartera, type Operacion } from "../forex/cartera";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

async function main(): Promise<void> {
  const cache = txt("cache");
  const listaRuta = process.argv[process.argv.indexOf("--lista") + 1] ?? txt("lista") ?? "";
  if (!cache || !existsSync(cache) || !existsSync(listaRuta)) {
    console.error("Hacen falta --lista L.json y --cache=V.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 10);
  const riesgoTotal = num("riesgo", 0.03);   // presupuesto de riesgo del PICO, no por unidad

  const lista: string[] = JSON.parse(readFileSync(listaRuta, "utf-8"));
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
  const datos = new Map<string, Vela[]>();
  for (const k of lista) {
    const v = g[k];
    if (v && v.length > 300) datos.set(k, v);
  }
  console.log(
    `${datos.size} instrumentos · coste ${costeBps} pb · presupuesto de riesgo en el pico ` +
      `${(riesgoTotal * 100).toFixed(0)}%\n`,
  );

  const BASE: AjustesPiramide = {
    stopAtr: 2, trailing: 2, maxUnidades: 1, minBeneficioR: 1,
    moverABreakeven: false, costeFraccion: costeBps / 10_000,
  };

  /**
   * `recorte` limita las velas a un tramo del calendario ANTES de simular.
   *
   * Se parte la serie, no las operaciones ya calculadas. Repartir a posteriori dejaria piramides
   * empezadas en una mitad y terminadas en la otra, y las dos mitades dejarian de ser
   * experimentos independientes.
   */
  const correrCon = (
    aj: AjustesPiramide, riesgoPico: number, recorte?: (v: Vela[]) => Vela[],
  ) => {
    const ops: Operacion[] = [];
    let simultaneas = 0;
    let maxSim = 0;
    let unidadesTotal = 0;
    const rs: number[] = [];
    for (const [s, vTodo] of datos) {
      const v = recorte ? recorte(vTodo) : vTodo;
      if (v.length < 100) continue;
      const a = atr(v, 14);
      const señales = volatilidad(v, a, 2);
      for (const dir of ["LARGO", "CORTO"] as const) {
        const r = simular(v, señales, a, dir, aj);
        simultaneas += r.perdidasSimultaneas;
        maxSim = Math.max(maxSim, r.maxSimultaneas);
        unidadesTotal += r.unidades.length;
        for (const u of r.unidades) {
          rs.push(u.r);
          ops.push({
            instrumento: s, tEntrada: v[u.iEntrada]!.t, tSalida: v[u.iSalida]!.t, r: u.r,
            direccion: dir,
            stopFraccion: u.entrada > 0
              ? Math.abs(u.entrada - u.stopInicial) / u.entrada
              : undefined,
          });
        }
      }
    }
    // EL RIESGO POR UNIDAD SE DIVIDE ENTRE EL TOPE: asi el riesgo del peor momento es el mismo
    // en todas las configuraciones y la comparacion mide reparto, no valentia.
    const cart = simularCartera(ops, {
      capital: 1000, riesgoPct: riesgoPico / aj.maxUnidades, maxPosiciones: 8,
      compuesto: true, maxExposicion: 1,
    });
    const ts = ops.map((o) => o.tEntrada);
    const años = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 86400 / 365 : 1;
    const gan = rs.filter((x) => x > 0);
    const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
    const exp = rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : 0;
    const va = rs.length > 1
      ? rs.reduce((s, x) => s + (x - exp) ** 2, 0) / (rs.length - 1) : 0;
    return {
      unidades: unidadesTotal,
      wr: rs.length ? gan.length / rs.length : 0,
      pf: sp > 0 ? gan.reduce((s, x) => s + x, 0) / sp : 0,
      exp,
      et: rs.length ? Math.sqrt(va / rs.length) : 0,
      anual: años > 0 ? (cart.capitalFinal / 1000) ** (1 / años) - 1 : 0,
      caida: cart.maxCaida,
      simultaneas, maxSim,
    };
  };

  const correr = (aj: AjustesPiramide) => correrCon(aj, riesgoTotal);

  const fila = (nombre: string, r: ReturnType<typeof correrCon>): string =>
    `${nombre.padEnd(30)}${String(r.unidades).padStart(7)}${(r.wr * 100).toFixed(0).padStart(5)}%` +
    `${r.pf.toFixed(2).padStart(7)}${r.exp.toFixed(3).padStart(8)}±${r.et.toFixed(3)}` +
    `${(r.anual * 100).toFixed(1).padStart(8)}%${(r.caida * 100).toFixed(0).padStart(8)}%` +
    `${String(r.maxSim).padStart(6)}${String(r.simultaneas).padStart(8)}`;
  const CAB =
    `${"variante".padEnd(30)}${"unids".padStart(7)}${"WR".padStart(6)}${"PF".padStart(7)}` +
    `${"exp R".padStart(14)}${"anual".padStart(9)}${"caida".padStart(9)}` +
    `${"maxU".padStart(6)}${"juntas".padStart(8)}`;

  // ---- LAS DOS MITADES DEL CALENDARIO -----------------------------------------------------
  //
  // Es la prueba que se le ha exigido a todo lo que se rechazo, y hay que exigirsela igual a lo
  // primero que sale bien. Si la ventaja de la piramide solo aparece en una mitad, es ruido.
  const tiempos = [...datos.values()].flat().map((x) => x.t).sort((a, b) => a - b);
  const corte = tiempos[Math.floor(tiempos.length / 2)] ?? 0;
  const f = (n: number) => new Date(n * 1000).toISOString().slice(0, 7);

  console.log("LAS DOS MITADES DEL CALENDARIO (simuladas por separado, no repartidas)");
  console.log(CAB);
  console.log("-".repeat(96));
  for (const [etq, filtro] of [
    [`1a mitad (hasta ${f(corte)})`, (v: Vela[]) => v.filter((c) => c.t < corte)],
    [`2a mitad (desde ${f(corte)})`, (v: Vela[]) => v.filter((c) => c.t >= corte)],
  ] as Array<[string, (v: Vela[]) => Vela[]]>) {
    for (const max of [1, 2]) {
      console.log(
        fila(`${etq} · tope ${max}`, correrCon({ ...BASE, maxUnidades: max }, riesgoTotal, filtro)),
      );
    }
  }

  console.log("");
  console.log("CUANTAS UNIDADES (todas con el MISMO riesgo en el pico)");
  console.log(CAB);
  console.log("-".repeat(96));
  for (const max of [1, 2, 3, 5]) {
    console.log(fila(`tope ${max} unidad(es)`, correr({ ...BASE, maxUnidades: max })));
  }

  console.log("\nQUE HACER CON LAS ANTERIORES AL AÑADIR (tope 3)");
  console.log(CAB);
  console.log("-".repeat(96));
  console.log(fila("dejarlas como estan", correr({ ...BASE, maxUnidades: 3 })));
  console.log(fila("moverlas a break-even", correr({ ...BASE, maxUnidades: 3, moverABreakeven: true })));

  console.log("\nCUANTO BENEFICIO EXIGIR ANTES DE AÑADIR (tope 3)");
  console.log(CAB);
  console.log("-".repeat(96));
  for (const b of [0, 0.5, 1, 2]) {
    console.log(fila(`añadir con +${b}R`, correr({ ...BASE, maxUnidades: 3, minBeneficioR: b })));
  }

  // ---- EL CONTROL QUE DECIDE ---------------------------------------------------------------
  //
  // Igualar el riesgo del PICO no iguala el riesgo MEDIO: la piramide solo esta llena de vez en
  // cuando, asi que de media arriesga menos que una unidad al riesgo pleno. Si una sola unidad a
  // riesgo reducido iguala a la piramide, entonces piramidar no aporta nada y la mejora era solo
  // haber bajado el riesgo, que no hace falta una piramide para conseguir.
  console.log("\nCONTROL: UNA SOLA UNIDAD a distintos riesgos");
  console.log(CAB);
  console.log("-".repeat(96));
  for (const r of [0.01, 0.015, 0.02, 0.03]) {
    console.log(
      fila(`1 unidad al ${(r * 100).toFixed(1)}%`, correrCon({ ...BASE, maxUnidades: 1 }, r)),
    );
  }

  console.log(
    "\n'juntas' son las veces que dos o mas unidades murieron en perdida a la vez: es el riesgo\n" +
      "que piramidar concentra y que la esperanza media no enseña. Todas las filas comprometen el\n" +
      "mismo riesgo en el peor momento, asi que un retorno mayor aqui SI significa mejor reparto\n" +
      "y no simplemente mas valentia.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
