/**
 * Cuanto esperar entre pasadas de un servicio.
 *
 * Vive aparte del CLI porque importar un CLI para probar una funcion arranca su bucle
 * infinito, y entonces la prueba nunca termina.
 */
/**
 * El castigo crece con los fallos SEGUIDOS en vez de reintentar al mismo ritmo. Es el mismo
 * error que costo 40 peticiones seguidas contra un 429 en la fase de memecoins. Y el suelo de
 * 60s existe para que una pasada lenta no encadene reintentos sin respiro.
 */
export function esperaTras(seguidos: number, cada: number, tardoSeg: number): number {
  const castigo = Math.min(seguidos, 5) * 300;
  return Math.max(60, cada - tardoSeg) + castigo;
}

