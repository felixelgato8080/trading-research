"""
El reloj del servidor, probado sin terminal.

    python -m unittest discover -s src/mt5 -p "test_*.py"

Se prueba con los dos fallos de verdad del 15 sep, porque los dos pasaron todas las guardas que
habia entonces y ninguno hizo fallar nada: el fichero salio mal fechado y los grabadores lo
creyeron.
"""
import unittest

from velas import PASO_M5, deducir_desfase

HORA = 3600
# XM en verano. `AHORA` es un instante cualquiera en UTC; lo unico que importa es la diferencia.
XM = 3 * HORA
AHORA = 1_789_500_000.0


def vela(desfase, antiguedad):
    """
    La hora que trae la vela mas nueva del terminal: la de su APERTURA, en hora del servidor.

    `antiguedad` son los segundos que hace que se abrio. Una vela viva lleva entre 0 y 300.
    """
    return AHORA + desfase - antiguedad


class ElReloj(unittest.TestCase):
    def test_una_vela_viva_da_el_desfase_de_verdad(self):
        # Da igual en que punto de sus cinco minutos se mire: sale +3 h siempre.
        for edad in (0, 60, 150, 299):
            self.assertEqual(deducir_desfase(vela(XM, edad), AHORA), XM, f"edad {edad}")

    def test_vale_para_los_husos_a_la_media_hora(self):
        # No es teorico: hay brokers en UTC+5:30 y el redondeo a la media hora existe por ellos.
        raro = 5 * HORA + 1800
        self.assertEqual(deducir_desfase(vela(raro, 150), AHORA), raro)

    def test_y_para_un_servidor_por_detras_de_utc(self):
        self.assertEqual(deducir_desfase(vela(-5 * HORA, 150), AHORA), -5 * HORA)

    def test_que_hace_el_medio_paso_y_que_no(self):
        # LO QUE HACE: centrar. Sin el, la cuenta sale sesgada hacia abajo toda la vida de la
        # vela —entre 0 y 300 s— y con el, el error queda en +-150.
        sin = lambda edad: (vela(XM, edad) - AHORA) - XM
        con = lambda edad: (vela(XM, edad) + PASO_M5 / 2.0 - AHORA) - XM
        self.assertEqual([sin(0), sin(299)], [0, -299])
        self.assertEqual([con(0), con(299)], [150, -149])

        # LO QUE NO HACE: salvar de nada por si solo. Para caer en el escalon de al lado hace
        # falta un sesgo de 900 s, y una vela viva no pasa de 300, asi que con medio paso o sin
        # el la respuesta es la misma en todas. Lo unico que mueve es el umbral del fallo: de
        # 900 s de retraso a 1.050.
        for edad in (0, 60, 150, 299):
            self.assertEqual(deducir_desfase(vela(XM, edad), AHORA), XM)
        self.assertEqual(deducir_desfase(vela(XM, 1049), AHORA), XM)
        self.assertEqual(deducir_desfase(vela(XM, 1051), AHORA), XM - 1800)


class LoQuePasoDeVerdad(unittest.TestCase):
    """Los dos fallos del 15 sep, tal cual, para que no vuelvan sin que nadie se entere."""

    def test_15_sep_0115_la_vela_llego_media_hora_tarde(self):
        # Con la vela 30 min atrasada la cuenta cae ENTERA en el escalon anterior: +2,5 h. El
        # fichero salio fechado media hora en el futuro, `div-ul-video` volvio a apuntar dos
        # senales que ya tenia y guardo dos salidas 30 minutos tarde.
        self.assertEqual(deducir_desfase(vela(XM, 1800), AHORA), XM - 1800)

    def test_y_ese_fallo_NO_se_ve_mirando_el_numero(self):
        # Por que no basta con exigir que la cuenta caiga cerca de la media hora exacta: un
        # retraso de 30 minutos justos cae EN la media hora siguiente, a cero de distancia. El
        # numero sale redondo y equivocado, que es la unica razon por la que se contrasta con el
        # desfase de la vez pasada.
        crudo = vela(XM, 1800) + PASO_M5 / 2.0 - AHORA
        self.assertEqual(abs(crudo - deducir_desfase(vela(XM, 1800), AHORA)), PASO_M5 / 2.0)

    def test_15_sep_2225_el_terminal_devolvio_historial_de_17_horas_antes(self):
        # Recien cambiado de cuenta. El desfase salio -17,5 h y el fichero, 20,5 h adelantado.
        self.assertEqual(deducir_desfase(vela(XM, int(20.5 * HORA)), AHORA), -17 * HORA - 1800)

    def test_un_desfase_imposible_se_puede_ver_sin_nada_mas(self):
        # Es la unica cota que se sostiene sola, y la que usa la primera pasada: ningun broker
        # esta a mas de 14 horas de UTC.
        d = deducir_desfase(vela(XM, int(20.5 * HORA)), AHORA)
        self.assertFalse(-12 * HORA <= d <= 14 * HORA)

    def test_pero_el_de_media_hora_SI_es_un_desfase_creible(self):
        # Y por eso ese no lo caza la cota, y hizo falta la comparacion con la vez pasada.
        d = deducir_desfase(vela(XM, 1800), AHORA)
        self.assertTrue(-12 * HORA <= d <= 14 * HORA)


class LaAntiguedadConElDesfaseDeAntes(unittest.TestCase):
    """
    La cuenta con la que `desfase_servidor` decide si la vela es de ahora.

    Va aqui y no dentro de la funcion porque la funcion habla con el terminal. Lo que importa es
    que la antiguedad NO use el desfase que se acaba de deducir: si lo usara, una vela atrasada
    saldria siempre con antiguedad cero, que es exactamente como colo el fallo de las 22:25.
    """

    @staticmethod
    def antiguedad(mejor, anterior):
        return AHORA - (mejor - anterior)

    def test_una_vela_viva_sale_con_minutos(self):
        self.assertEqual(self.antiguedad(vela(XM, 150), XM), 150)

    def test_la_del_viernes_un_domingo_sale_con_horas(self):
        self.assertAlmostEqual(self.antiguedad(vela(XM, 40 * HORA), XM) / HORA, 40)

    def test_con_el_desfase_nuevo_saldria_casi_cero(self):
        # La trampa, escrita: deducir el desfase de una vela atrasada y luego medir la
        # antiguedad de esa vela CON ESE desfase da ~0 siempre, porque el error se cancela solo.
        m = vela(XM, 1800)
        deducido = deducir_desfase(m, AHORA)
        self.assertLessEqual(abs(self.antiguedad(m, deducido)), PASO_M5 / 2.0)
        # Con el de antes, en cambio, se ve entero.
        self.assertEqual(self.antiguedad(m, XM), 1800)


if __name__ == "__main__":
    unittest.main()
