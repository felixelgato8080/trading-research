/**
 * Parte el universo en GANADORAS y PERDEDORAS para aislar el sesgo de supervivencia.
 *
 *   npm run perdedoras -- --cache=v.json --salida-buenas=b.json --salida-malas=m.json
 *
 * EL RAZONAMIENTO
 * ---------------
 * El universo son 31 criptos vivas hoy: estan elegidas a toro pasado. Si la estrategia solo
 * funciona porque las monedas subieron, entonces deberia FALLAR en la mitad que peor lo hizo.
 * Si funciona igual de bien en las que se hundieron, el resultado no viene de haber elegido
 * ganadoras.
 *
 * No sustituye a un universo historico de verdad (con LUNA y FTT dentro), pero es la prueba mas
 * dura que se puede hacer con datos gratis, y va en la direccion correcta: las perdedoras de
 * este universo son lo mas parecido que hay a las monedas que murieron.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Vela } from "../forex/datos";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

function main(): void {
  const g = JSON.parse(readFileSync(txt("cache")!, "utf-8")) as Record<string, Vela[]>;
  const filas: Array<[string, number]> = [];
  for (const [s, v] of Object.entries(g)) {
    if (v.length < 700) continue;
    filas.push([s, v[v.length - 1]!.c / v[0]!.c]);
  }
  filas.sort((a, b) => b[1] - a[1]);

  console.log("Rendimiento total desde el inicio de cada serie:\n");
  for (const [s, m] of filas) {
    console.log(`  ${s.padEnd(16)}${m.toFixed(2).padStart(9)}x${((m - 1) * 100).toFixed(0).padStart(9)}%`);
  }

  const mitad = Math.floor(filas.length / 2);
  const buenas = filas.slice(0, mitad).map(([s]) => s);
  const malas = filas.slice(mitad).map(([s]) => s);
  // Las que perdieron dinero de verdad: lo mas cercano a una moneda muerta.
  const hundidas = filas.filter(([, m]) => m < 1).map(([s]) => s);

  writeFileSync(txt("salida-buenas")!, JSON.stringify(buenas));
  writeFileSync(txt("salida-malas")!, JSON.stringify(malas));
  const dest = txt("salida-hundidas");
  if (dest) writeFileSync(dest, JSON.stringify(hundidas));

  console.log(`\n${buenas.length} buenas · ${malas.length} malas · ${hundidas.length} en perdidas absolutas`);
  console.log(`Hundidas: ${hundidas.join(", ")}`);
}

main();
