/**
 * Barrido de barras IMPOSIBLES en cualquier cache de velas.
 *
 *   npm run sanidad -- --cache=v.json [--etiqueta=CRIPTO]
 *
 * Comparando Yahoo con Binance salio que ATOM tenia un minimo con un 100,958% de diferencia:
 * un tick corrupto. Un solo dato asi falsea una serie entera, porque el minimo dispara el stop
 * y el maximo mueve el trailing.
 *
 * Se buscan seis cosas, todas imposibles en un mercado de verdad:
 *   1. Precios cero o negativos.
 *   2. Maximo menor que el minimo.
 *   3. Apertura o cierre FUERA del rango maximo-minimo.
 *   4. Rango absurdo: el maximo mas del doble del minimo en una vela.
 *   5. Saltos de mas del 50% entre cierres consecutivos.
 *   6. Velas repetidas con el mismo instante.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { saludCuerpo } from "../forex/agregar";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
const dia = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

function main(): void {
  const ruta = txt("cache");
  const etiqueta = txt("etiqueta") ?? "";
  if (!ruta || !existsSync(ruta)) {
    console.error("Falta --cache");
    process.exitCode = 1;
    return;
  }
  const datos = JSON.parse(readFileSync(ruta, "utf-8")) as Record<string, Vela[]>;

  let totalVelas = 0;
  const problemas: string[] = [];
  const conteo: Record<string, number> = {};
  const anota = (tipo: string, detalle: string): void => {
    conteo[tipo] = (conteo[tipo] ?? 0) + 1;
    if (problemas.length < 25) problemas.push(`  ${tipo.padEnd(22)} ${detalle}`);
  };

  for (const [s, velas] of Object.entries(datos)) {
    totalVelas += velas.length;
    const vistos = new Set<number>();
    for (let i = 0; i < velas.length; i += 1) {
      const v = velas[i]!;
      if (vistos.has(v.t)) anota("vela repetida", `${s} ${dia(v.t)}`);
      vistos.add(v.t);

      if (!(v.o > 0) || !(v.h > 0) || !(v.l > 0) || !(v.c > 0)) {
        anota("precio <= 0", `${s} ${dia(v.t)} o=${v.o} h=${v.h} l=${v.l} c=${v.c}`);
        continue;
      }
      if (v.h < v.l) anota("maximo < minimo", `${s} ${dia(v.t)} h=${v.h} l=${v.l}`);
      if (v.o > v.h * 1.0001 || v.o < v.l * 0.9999) {
        anota("apertura fuera", `${s} ${dia(v.t)} o=${v.o} [${v.l}, ${v.h}]`);
      }
      if (v.c > v.h * 1.0001 || v.c < v.l * 0.9999) {
        anota("cierre fuera", `${s} ${dia(v.t)} c=${v.c} [${v.l}, ${v.h}]`);
      }
      if (v.h > v.l * 2) {
        anota("rango absurdo", `${s} ${dia(v.t)} h=${v.h} l=${v.l} (x${(v.h / v.l).toFixed(1)})`);
      }
      if (i > 0) {
        const prev = velas[i - 1]!.c;
        if (prev > 0) {
          const salto = Math.abs(v.c - prev) / prev;
          if (salto > 0.5) {
            anota("salto > 50%", `${s} ${dia(v.t)} ${prev.toPrecision(5)} -> ${v.c.toPrecision(5)}`);
          }
        }
      }
    }
  }

  const total = Object.values(conteo).reduce((a, b) => a + b, 0);
  console.log(
    `\n### ${etiqueta} ### ${Object.keys(datos).length} series · ` +
      `${totalVelas.toLocaleString("es")} velas · ${total} problemas`,
  );
  // SIN `return` AQUI aunque no haya problemas.
  //
  // Lo hubo, y anulaba la comprobacion de abajo justo en el caso que la motivo: el diario de
  // divisas de Yahoo tiene CERO barras imposibles y el cuerpo roto. Una serie limpia es donde
  // mas falta hace mirar el cuerpo, y era donde no se miraba.
  if (total === 0) {
    console.log("  Sin barras imposibles.");
  } else {
    for (const [k, n] of Object.entries(conteo).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(22)} ${n}`);
    }
  }
  // ---- SALUD DEL CUERPO ------------------------------------------------------------------
  //
  // DOS SINTOMAS DISTINTOS, y confundirlos hace tirar datos buenos.
  //
  //   - Cuerpo MEDIO bajo: el feed esta roto. El diario de divisas de Yahoo da 0,023 porque la
  //     apertura y el cierre salen del mismo instante. Ahi no se puede medir nada de cuerpo.
  //   - Muchos cuerpos exactamente cero pero cuerpo medio ALTO: es cuantizacion. En 5m una vela
  //     de un pip abre y cierra en el mismo tick. El feed esta perfectamente bien.
  //
  // La primera version marcaba las dos igual y decia "no medir aqui" sobre el 5m de forex, que
  // tiene cuerpo medio 0,68. Habria hecho descartar datos buenos por un aviso mal calibrado.
  console.log("\nCUERPO (|cierre-apertura| / rango). Sano ronda 0,40:");
  const rotas: string[] = [];
  const avisos: string[] = [];
  for (const [k, v] of Object.entries(datos)) {
    const s = saludCuerpo(v);
    if (s.velas === 0) continue;
    const linea =
      `  ${k.padEnd(22)} cuerpo medio ${s.cuerpoMedio.toFixed(3)} · ` +
      `${(s.cuerpoCero * 100).toFixed(1)}% con cuerpo cero`;
    if (s.cuerpoMedio < 0.15) rotas.push(linea);
    else if (s.cuerpoCero > 0.05) avisos.push(linea);
  }
  if (rotas.length) {
    console.log(`  ${rotas.length} serie(s) ROTAS. NO medir reglas de cuerpo aqui:`);
    for (const f of rotas.slice(0, 12)) console.log(f);
    if (rotas.length > 12) console.log(`  ... y ${rotas.length - 12} mas`);
  }
  if (avisos.length) {
    console.log(`  ${avisos.length} serie(s) con cuerpos cero frecuentes pero cuerpo medio sano.`);
    console.log("  Es cuantizacion, no un feed roto. Se puede medir, pero un hueco o un bloque");
    console.log("  diminuto ahi es ruido: exige un tamaño minimo en ATR.");
    for (const f of avisos.slice(0, 6)) console.log(f);
  }
  if (!rotas.length && !avisos.length) {
    console.log("  Todas las series tienen cuerpos utilizables.");
  }
  console.log("");
  for (const p of problemas) console.log(p);
}

main();
