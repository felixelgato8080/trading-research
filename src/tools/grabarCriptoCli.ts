/**
 * Grabador diario de la ruptura de volatilidad en cripto. NO opera, NO toca dinero.
 *
 *   npm run grabar:cripto -- --registro=RUTA.json [--lista=cripto_ok.json] [--informe]
 *
 * Se ejecuta una vez al dia. Cada pasada:
 *   1. Descarga las velas diarias de las monedas de la lista.
 *   2. Apunta las señales nuevas como PENDIENTES (la entrada aun no existe).
 *   3. Convierte las pendientes de ayer en posiciones con la apertura de hoy.
 *   4. Mueve los trailing y cierra lo que haya tocado stop.
 *   5. Guarda el registro y escribe un informe.
 *
 * EL REGISTRO VIVE FUERA DE CUALQUIER CONTENEDOR. En este proyecto ya se perdieron 109.800
 * creditos de Helius por guardar datos dentro de un contenedor que luego se recreo. La ruta se
 * pasa a mano a proposito, para que quede a la vista donde esta.
 *
 * `--informe` no descarga nada: solo lee el registro y lo resume. Sirve para mirar el estado
 * sin gastar peticiones ni tocar el fichero.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { velasBinance } from "../forex/binance";
import {
  registroVacio,
  avanzar,
  resumir,
  VERSION_REGISTRO,
  type Registro,
  type AjustesGrabador,
  type Cerrada,
} from "../forex/grabadorCripto";
import { simularCartera, type Operacion } from "../forex/cartera";
import { auditar, informeAuditoria } from "../forex/auditor";
import { deCripto } from "../forex/auditables";

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

/**
 * Los ajustes por defecto son los medidos: vol 2 ATR, stop 2 ATR, trailing 2x.
 *
 * NO cambiarlos a mitad de la grabacion. Si se cambian, el registro deja de ser comparable y el
 * grabador se niega a continuar sobre un registro con otros ajustes.
 */
function ajustesDeArgs(): AjustesGrabador {
  return {
    k: num("k", 2),
    atrStop: num("stop", 2),
    trailing: num("trailing", 2),
    periodoAtr: num("atr", 14),
    costeR: num("coste", 0.05),
  };
}

function mismosAjustes(a: AjustesGrabador, b: AjustesGrabador): boolean {
  return (
    a.k === b.k && a.atrStop === b.atrStop && a.trailing === b.trailing &&
    a.periodoAtr === b.periodoAtr && a.costeR === b.costeR
  );
}

/** Precio en ancho fijo. `toPrecision` desborda con monedas de 8 decimales como SHIB. */
function precio(x: number): string {
  const s = x >= 1 ? x.toFixed(4) : x.toExponential(4);
  return s.padStart(13);
}

function informe(reg: Registro): void {
  const dias = (Date.parse(reg.ultimaEjecucion) - Date.parse(reg.inicio)) / 86_400_000;
  console.log(
    `\nREGISTRO · arrancado ${reg.inicio.slice(0, 10)} · ${dias.toFixed(0)} dias · ` +
      `${reg.ejecuciones} ejecuciones`,
  );
  console.log(
    `ajustes: ruptura ${reg.ajustes.k} ATR · stop ${reg.ajustes.atrStop} ATR · ` +
      `trailing ${reg.ajustes.trailing}x · coste ${(reg.ajustes.costeR * 100).toFixed(1)}% del riesgo` +
      ` · datos de ${reg.fuente ?? "yahoo"}`,
  );

  if (reg.pendientes.length) {
    console.log(`\nPENDIENTES (entran en la proxima apertura): ${reg.pendientes.length}`);
    for (const p of reg.pendientes) {
      console.log(`   ${p.instrumento.padEnd(16)}${p.direccion.padEnd(7)}señal ${p.diaSenal}`);
    }
  }

  if (reg.abiertas.length) {
    console.log(`\nABIERTAS: ${reg.abiertas.length}`);
    console.log(
      `   ${"moneda".padEnd(16)}${"dir".padEnd(7)}${"entrada".padStart(12)}${"stop".padStart(12)}` +
        `${"R flotante".padStart(12)}  desde`,
    );
    for (const p of reg.abiertas) {
      const largo = p.direccion === "LARGO";
      const flot = (largo ? p.extremo - p.precioEntrada : p.precioEntrada - p.extremo) / p.riesgo;
      console.log(
        `   ${p.instrumento.padEnd(16)}${p.direccion.padEnd(7)}` +
          `${precio(p.precioEntrada)}${precio(p.nivelStop)}` +
          `${flot.toFixed(2).padStart(12)}  ${p.diaEntrada}`,
      );
    }
  }

  // La medida honesta excluye lo que se apunto cuando la entrada ya era conocida.
  const estrictas = reg.cerradas.filter((c) => !c.entradaConocidaAlApuntar);
  const rec = resumir(reg.cerradas);
  const est = resumir(estrictas);

  console.log(`\nCERRADAS: ${reg.cerradas.length}`);
  if (rec.n > 0) {
    console.log(
      `   todas:     ${rec.n} ops · acierto ${(rec.wr * 100).toFixed(0)}% · PF ${rec.pf.toFixed(2)} · ` +
        `${rec.exp.toFixed(3)}R · el coste se lleva el ${(rec.peaje * 100).toFixed(0)}% del bruto`,
    );
    console.log(
      est.n > 0
        ? `   estrictas: ${est.n} ops · acierto ${(est.wr * 100).toFixed(0)}% · PF ${est.pf.toFixed(2)} · ${est.exp.toFixed(3)}R`
        : `   estrictas: 0 (todas se apuntaron con la entrada ya conocida)`,
    );
    console.log("   La linea que vale es la ESTRICTA: son las que se supieron antes del precio.");

    const ops: Operacion[] = estrictas.map((c) => ({
      instrumento: c.instrumento,
      tEntrada: Date.parse(c.diaEntrada) / 1000,
      tSalida: Date.parse(c.diaSalida) / 1000,
      r: c.r,
    }));
    if (ops.length >= 5) {
      const sim = simularCartera(ops, {
        capital: 1000, riesgoPct: 0.01, maxPosiciones: 8, compuesto: true,
      });
      console.log(
        `\n   Con 1.000 y 1% de riesgo, tope 8: ${sim.capitalFinal.toFixed(0)} ` +
          `(peor caida ${(sim.maxCaida * 100).toFixed(0)}%, ${sim.rechazadas} señales sin hueco)`,
      );
    }

    const ult = [...reg.cerradas].slice(-8).reverse();
    console.log("\n   Ultimas cerradas:");
    for (const c of ult) {
      console.log(
        `   ${c.diaSalida}  ${c.instrumento.padEnd(16)}${c.direccion.padEnd(7)}` +
          `${(c.r >= 0 ? "+" : "") + c.r.toFixed(2)}R`.padStart(9) +
          `  ${c.motivo}${c.entradaConocidaAlApuntar ? "  (no estricta)" : ""}`,
      );
    }
  }

  if (reg.discrepancias.length) {
    console.log(`\nAVISO · ${reg.discrepancias.length} precios cambiaron despues de grabarse:`);
    for (const d of reg.discrepancias.slice(0, 10)) {
      console.log(`   ${d.instrumento} ${d.dia} ${d.campo}: grabado ${d.grabado}, ahora ${d.ahora}`);
    }
    console.log("   Se respeta lo grabado. Si son muchos, la fuente de datos no es fiable.");
  }

  const faltan = Math.max(0, 40 - estrictas.length);
  console.log(
    faltan > 0
      ? `\nFaltan ~${faltan} operaciones estrictas para que la muestra empiece a decir algo.`
      : `\nYa hay ${estrictas.length} operaciones estrictas: la muestra empieza a ser util.`,
  );
}

async function main(): Promise<void> {
  const ruta = txt("registro");
  if (!ruta) {
    console.error("Falta --registro=RUTA.json (ponla FUERA de cualquier contenedor)");
    process.exitCode = 1;
    return;
  }

  const ahora = new Date().toISOString();
  const aj = ajustesDeArgs();
  // Binance por defecto: es el exchange donde se operaria de verdad y sus rangos no estan
  // recortados. Yahoo queda como opcion solo para comparar.
  const fuente: "yahoo" | "binance" = process.argv.includes("--yahoo") ? "yahoo" : "binance";

  let reg: Registro;
  if (existsSync(ruta)) {
    reg = JSON.parse(readFileSync(ruta, "utf-8")) as Registro;
    if (reg.version !== VERSION_REGISTRO) {
      console.error(`El registro es version ${reg.version} y este grabador escribe la ${VERSION_REGISTRO}.`);
      process.exitCode = 1;
      return;
    }
    if ((reg.fuente ?? "yahoo") !== fuente) {
      console.error(`El registro usa datos de ${reg.fuente ?? "yahoo"} y se han pedido de ${fuente}.`);
      console.error("Cambiar de fuente a mitad invalida la comparacion: empieza otro registro.");
      process.exitCode = 1;
      return;
    }
    if (!mismosAjustes(reg.ajustes, aj)) {
      console.error("Los ajustes no coinciden con los del registro. Cambiarlos a mitad invalida");
      console.error("la prueba: empieza un registro nuevo en otra ruta si quieres otros ajustes.");
      console.error(`  registro: ${JSON.stringify(reg.ajustes)}`);
      console.error(`  pedidos:  ${JSON.stringify(aj)}`);
      process.exitCode = 1;
      return;
    }
  } else {
    reg = registroVacio(aj, ahora, fuente);
    console.log(`Registro nuevo en ${ruta} · arranca ${ahora.slice(0, 10)}`);
    console.log("A partir de hoy solo se apuntan señales nuevas. Lo anterior no cuenta.\n");
  }

  if (process.argv.includes("--informe")) {
    informe(reg);
    return;
  }

  const lista: string[] = JSON.parse(readFileSync(txt("lista") ?? "cripto_ok.json", "utf-8"));
  const datos = new Map<string, Vela[]>();
  let fallos = 0;
  for (const s of lista) {
    try {
      const v = fuente === "binance"
        ? await velasBinance(s, "1d", 400)
        : await velas(s, "1d");
      if (v.length > 30) datos.set(s, v);
      else fallos += 1;
    } catch {
      fallos += 1;
    }
    await dormir(350);
  }
  console.log(`${datos.size} monedas de ${fuente}${fallos ? ` · ${fallos} fallaron` : ""}`);

  // Con muchos fallos, avanzar es peligroso: las posiciones sin datos se quedarian congeladas y
  // las señales de esas monedas no se verian. Mejor no tocar el registro y reintentar.
  if (datos.size < lista.length / 2) {
    console.error("Han fallado mas de la mitad de las descargas. No se toca el registro.");
    process.exitCode = 1;
    return;
  }

  const av = avanzar(reg, datos, ahora);

  // Copia de seguridad antes de sobrescribir: el registro es irreemplazable, se construye con
  // tiempo real y no se puede regenerar.
  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  writeFileSync(ruta, JSON.stringify(av.registro, null, 2));

  console.log(
    `\n+${av.nuevasPendientes.length} señales · +${av.nuevasAbiertas.length} abiertas · ` +
      `+${av.nuevasCerradas.length} cerradas`,
  );
  for (const p of av.nuevasPendientes) {
    console.log(`   SEÑAL   ${p.instrumento.padEnd(16)}${p.direccion}  ${p.diaSenal}`);
  }
  for (const c of av.nuevasCerradas) {
    console.log(
      `   CIERRE  ${c.instrumento.padEnd(16)}${c.direccion.padEnd(7)}` +
        `${(c.r >= 0 ? "+" : "") + c.r.toFixed(2)}R  ${c.motivo}`,
    );
  }

  informe(av.registro);

  // ---- LA AUDITORIA. Sobre TODO lo cerrado, no solo lo de hoy. -------------------------------
  //
  // Un fallo introducido hoy puede volver imposibles operaciones grabadas hace meses, y auditar
  // solo lo nuevo dejaria pasar justo eso. Cuesta milisegundos.
  const auditoria = auditar(av.registro.cerradas.map(deCripto), (s) => datos.get(s));
  console.log(`\n${informeAuditoria(auditoria)}`);
  if (auditoria.anomalias.length > 0) {
    console.error(
      "HAY OPERACIONES IMPOSIBLES EN EL REGISTRO. No es una advertencia de estilo: alguno de " +
        "los precios de arriba no existio nunca, asi que el resultado que salga de aqui no vale.",
    );
    process.exitCode = 1;
  }

  console.log(`\nGuardado en ${ruta}`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
