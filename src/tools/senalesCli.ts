/**
 * SEÑALES DEL DIA en formato accionable: Señal / Entrada / SL / TP / Justificacion.
 *
 *   npm run senales -- --lista monedas.json [--capital=1000] [--riesgo=0.01] [--tope=8]
 *
 * POR QUE ESTE CLI Y NO UN ANALISIS A OJO
 * ---------------------------------------
 * El formato lo pidio Felix y es bueno: dice exactamente que hacer. Lo que cambia es de donde
 * sale cada numero. No de leer un grafico, sino de la unica estrategia que ha sobrevivido a
 * todas las pruebas del proyecto: ruptura de volatilidad de 2 ATR, stop de 2 ATR, trailing 2x.
 *
 *   PF 1,54 · 0,297R por operacion · 25 de 30 monedas en verde · 7 de 9 años positivos
 *   24,7% anual con 37% de peor caida, a 1% de riesgo y tope de 8 posiciones
 *
 * EL CAMPO "TP" NECESITA UNA ACLARACION HONESTA
 * ---------------------------------------------
 * El formato pide objetivo fijo con ratio 1:2. Esta estrategia NO tiene objetivo fijo: usa
 * trailing sin techo. No es un capricho — medido en este proyecto, pasar de objetivo fijo a
 * trailing sube el PF de 0,67 a 1,09, porque el resultado vive en la cola y un objetivo fijo la
 * corta. Asi que el TP se reporta como el nivel del trailing, que se mueve, y se dice cual seria
 * el equivalente 1:2 para que la diferencia quede a la vista.
 *
 * NO EJECUTA NADA. Imprime lo que la estrategia dice; la decision es de quien lo lee.
 */
import { readFileSync } from "node:fs";
import { velasBinance } from "../forex/binance";
import { atr } from "../forex/multiTf";
import { volatilidad } from "../forex/rupturas";
import { volumenMedio } from "../forex/volumen";
import type { Vela } from "../forex/datos";

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
const precio = (x: number): string => (x >= 1 ? x.toFixed(4) : x.toExponential(4));

interface Señal {
  simbolo: string;
  direccion: "COMPRA" | "VENTA";
  cierre: number;
  atr: number;
  stop: number;
  riesgo: number;
  /** Cuanto se movio el precio en la vela, en ATR. Mide la fuerza de la ruptura. */
  fuerza: number;
  /** Volumen de la vela frente a la media de 20. Se OBSERVA, no filtra. */
  volumenRel: number | null;
  dia: string;
}

async function main(): Promise<void> {
  const capital = num("capital", 1000);
  const riesgoPct = num("riesgo", 0.01);
  const tope = num("tope", 8);
  // Permite revisar un dia pasado: sirve para comprobar la herramienta y para repasar lo que
  // la estrategia habria dicho, sin tener que esperar a que salga una señal.
  const dia = txt("dia");
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const señales: Señal[] = [];
  let revisadas = 0;
  for (const s of lista) {
    try {
      const v: Vela[] = await velasBinance(s, "1d", 200);
      if (v.length < 60) continue;
      revisadas += 1;
      const a = atr(v, 14);
      const vm = volumenMedio(v, 20);
      // La ULTIMA vela cerrada. La de hoy aun se esta formando y usarla seria mirar el futuro.
      // Con --dia se busca esa fecha concreta.
      const i = dia
        ? v.findIndex((x) => new Date(x.t * 1000).toISOString().slice(0, 10) === dia)
        : v.length - 2;
      if (i < 20) continue;
      const av = a[i];
      if (av == null || !(av > 0)) continue;

      const disparos = volatilidad(v, a, 2).filter((x) => x.i === i);
      if (disparos.length === 0) continue;
      const d = disparos[0]!;
      const vela = v[i]!;
      const m = vm[i];
      señales.push({
        simbolo: s,
        direccion: d.direccion === "LARGO" ? "COMPRA" : "VENTA",
        cierre: vela.c,
        atr: av,
        stop: d.direccion === "LARGO" ? vela.c - av * 2 : vela.c + av * 2,
        riesgo: av * 2,
        fuerza: Math.abs(vela.c - vela.o) / av,
        volumenRel: vela.v != null && m != null && m > 0 ? vela.v / m : null,
        dia: new Date(vela.t * 1000).toISOString().slice(0, 10),
      });
    } catch { /* se salta */ }
    await dormir(250);
  }

  console.log(
    `\n${revisadas} monedas revisadas · vela cerrada del ` +
      `${señales[0]?.dia ?? new Date().toISOString().slice(0, 10)}\n` +
      `Capital ${capital} · riesgo ${(riesgoPct * 100).toFixed(1)}% ` +
      `(${(capital * riesgoPct).toFixed(2)} por operacion) · tope ${tope} posiciones\n`,
  );

  if (señales.length === 0) {
    console.log("SEÑAL: ESPERAR");
    console.log("  Justificacion: ninguna moneda cerro con un movimiento de 2 ATR desde su");
    console.log("  apertura. Sin ruptura no hay entrada; la estrategia opera unas 143 veces al");
    console.log("  año en 30 monedas, asi que la mayoria de dias no hay nada que hacer.");
    return;
  }

  // Si hay mas señales que huecos, se ordenan por fuerza de la ruptura. La regla se fija aqui,
  // no se elige despues de ver cual salio bien.
  señales.sort((a, b) => b.fuerza - a.fuerza);
  const dinero = capital * riesgoPct;

  console.log(`${señales.length} señal(es). Se muestran por fuerza de ruptura, las ${tope} primeras son las que caben.\n`);

  señales.forEach((s, k) => {
    const dentro = k < tope;
    const largo = s.direccion === "COMPRA";
    const unidades = dinero / s.riesgo;
    const nocional = unidades * s.cierre;
    // Equivalente 1:2, solo para comparar con el formato pedido.
    const tp12 = largo ? s.cierre + s.riesgo * 2 : s.cierre - s.riesgo * 2;

    console.log(`${"─".repeat(66)}`);
    console.log(`${s.simbolo}${dentro ? "" : "   (fuera del tope de posiciones)"}`);
    console.log(`  SEÑAL:            ${s.direccion}`);
    console.log(`  PRECIO DE ENTRADA: apertura de la vela siguiente (~${precio(s.cierre)})`);
    console.log(`  STOP LOSS:        ${precio(s.stop)}   (2 ATR = ${precio(s.riesgo)})`);
    console.log(`  TAKE PROFIT:      SIN objetivo fijo — trailing a 2x el stop`);
    console.log(`                    (el 1:2 que pide el formato seria ${precio(tp12)};`);
    console.log(`                     medido, el objetivo fijo baja el PF de 1,09 a 0,67)`);
    console.log(`  TAMAÑO:           ${unidades.toPrecision(4)} unidades ≈ ${nocional.toFixed(2)} de nocional`);
    console.log(
      `  JUSTIFICACION:    el precio cerro a ${s.fuerza.toFixed(1)} ATR de su apertura, por` +
        ` encima\n                    del umbral de 2 ATR. ` +
        (s.volumenRel != null ? `Volumen ${s.volumenRel.toFixed(1)}x la media de 20.` : "Sin dato de volumen."),
    );
  });

  console.log(`${"─".repeat(66)}`);
  const nocionalTotal = señales.slice(0, tope).reduce(
    (acc, s) => acc + (dinero / s.riesgo) * s.cierre, 0,
  );
  console.log(
    `\nExposicion total si se toman las ${Math.min(tope, señales.length)} primeras: ` +
      `${nocionalTotal.toFixed(2)} = ${(nocionalTotal / capital).toFixed(2)}x el capital.`,
  );
  if (nocionalTotal > capital) {
    console.log("AVISO: pasa de 1x. Con cuenta al contado no cabe; haria falta margen.");
  }
  console.log(
    "\nEsto NO es una recomendacion: es lo que dice la estrategia medida. La decision es tuya.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
