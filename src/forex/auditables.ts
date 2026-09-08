/**
 * Adaptadores: de lo que guarda cada grabador a lo que audita `auditor.ts`.
 *
 * Los dos grabadores nacieron con vocabularios distintos —uno habla de `par` y epochs, el otro de
 * `instrumento` y dias— y unificarlos a estas alturas seria reescribir dos registros en marcha
 * para ganar elegancia. Se traduce aqui, en veinte lineas probadas, y las invariantes se
 * escriben UNA vez.
 */
import type { Cerrada as CerradaForex } from "./grabador";
import type { Cerrada as CerradaCripto } from "./grabadorCripto";
import type { OperacionAuditable } from "./auditor";

/** Un dia (YYYY-MM-DD) al epoch de su vela diaria, que abre a las 00:00 UTC. */
export function epochDelDia(dia: string): number {
  return Math.floor(Date.parse(`${dia}T00:00:00Z`) / 1000);
}

export function deForex(c: CerradaForex): OperacionAuditable {
  return {
    par: c.par,
    direccion: c.direccion,
    entrada: c.entrada,
    stop: c.stop,
    objetivo: c.objetivo,
    salida: c.salida,
    adversa: c.motivo === "STOP",
    r: c.r,
    tSeñal: c.tSeñal,
    tEntrada: c.tEntrada,
    tSalida: c.tSalida,
  };
}

/**
 * El grabador de cripto lleva TRAILING: el `nivelStop` que guarda es el ultimo, no el inicial.
 *
 * El stop inicial —el que define el riesgo y el unico contra el que tiene sentido comprobar que
 * esta del lado bueno— se reconstruye desde la entrada y el riesgo congelado. Pasarle el nivel
 * final haria que toda operacion ganadora pareciera tener el stop del lado malo.
 */
/**
 * Lo que el bot en papel guarda de una operacion cerrada.
 *
 * Se declara aqui y no se importa de `botCli` porque un CLI no deberia exportar tipos que use
 * una libreria: la flecha iria al reves y arrastraria todo el CLI a cualquiera que audite.
 */
export interface CerradaBot {
  simbolo: string;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  salida: number;
  r: number;
  riesgo?: number;
  diaSenal?: string;
  diaEntrada?: string;
  diaSalida?: string;
}

/**
 * El bot no siempre puede dar todo: sus operaciones viejas no llevaban dias ni riesgo, y sin el
 * riesgo no hay stop inicial que reconstruir.
 *
 * Devuelve null en vez de rellenar huecos con supuestos. Una operacion que no se puede auditar
 * tiene que contarse como tal, no colarse entre las buenas con datos inventados.
 */
export function deBot(c: CerradaBot): OperacionAuditable | null {
  if (c.riesgo == null || !c.diaSenal || !c.diaEntrada || !c.diaSalida) return null;
  const largo = c.direccion === "LARGO";
  return {
    par: c.simbolo,
    direccion: c.direccion,
    entrada: c.entrada,
    stop: largo ? c.entrada - c.riesgo : c.entrada + c.riesgo,
    salida: c.salida,
    // Stop y trailing, las dos adversas. Esta estrategia no tiene objetivo.
    adversa: true,
    r: c.r,
    tSeñal: epochDelDia(c.diaSenal),
    tEntrada: epochDelDia(c.diaEntrada),
    tSalida: epochDelDia(c.diaSalida),
  };
}

export function deCripto(c: CerradaCripto): OperacionAuditable {
  const largo = c.direccion === "LARGO";
  return {
    par: c.instrumento,
    direccion: c.direccion,
    entrada: c.precioEntrada,
    stop: largo ? c.precioEntrada - c.riesgo : c.precioEntrada + c.riesgo,
    salida: c.precioSalida,
    // Las dos salidas de esta estrategia son adversas: el stop inicial y el trailing. No hay
    // objetivo, asi que no hay ninguna salida a favor.
    adversa: true,
    r: c.r,
    rBruto: c.rBruto,
    tSeñal: epochDelDia(c.diaSenal),
    tEntrada: epochDelDia(c.diaEntrada),
    tSalida: epochDelDia(c.diaSalida),
  };
}
