/**
 * Guardar un registro sin dejar nunca un fichero a medias.
 *
 * POR QUE HACE FALTA. `writeFileSync` no es atomico: trunca el fichero y luego escribe. Quien lo
 * lea en ese instante ve un JSON cortado. Mientras hubo UN solo proceso tocando los registros
 * daba igual, porque nadie leia a la vez. Desde el 13 sep hay tres que si:
 *
 *   - el grabador de `afinado`, cada 5 minutos
 *   - el grabador de `video` y el `git add` del commit, cada 15
 *   - el ejecutor, que lee los dos registros para decidir que ordenes poner
 *
 * Un JSON truncado en el momento equivocado no da un error bonito: el ejecutor pierde la pasada,
 * y en el peor caso el commit guarda el fichero roto en el historial, que es justamente lo que
 * este proyecto usa como prueba de que los precios no se retocaron.
 *
 * COMO SE ARREGLA: se escribe al lado y se renombra encima. El renombrado SI es atomico —en
 * Windows es MoveFileEx con MOVEFILE_REPLACE_EXISTING, en POSIX es rename(2)— asi que el fichero
 * de destino o tiene el contenido viejo entero, o el nuevo entero. Nunca la mitad.
 *
 * La copia .bak se sigue haciendo antes, y sigue sirviendo para lo de siempre: volver atras una
 * pasada si algo sale mal.
 */
import { copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";

export function guardarRegistro(ruta: string, datos: unknown): void {
  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  const temporal = `${ruta}.tmp`;
  writeFileSync(temporal, JSON.stringify(datos, null, 2));
  renameSync(temporal, ruta);
}
