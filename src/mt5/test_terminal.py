"""
La conexion con el terminal, probada con un MT5 de mentira.

    python -m unittest discover -s src/mt5 -p "test_*.py"

Se prueba porque el 15 sep el ejecutor encadeno doce pasadas -una hora- sin poner nada, con una
sola linea en el log: `initialize` devolvia IPC timeout, `conectar` se rendia al primer intento y
la cadena salia con codigo 0.
"""
import unittest

from terminal import conectar


class FalsoMT5:
    """
    Un terminal de mentira. `guion` dice que devuelve cada `initialize`:

        True    conecta y tiene cuenta
        "sin"   contesta que si pero todavia sin cuenta (terminal recien arrancado)
        False   no contesta
    """

    def __init__(self, guion):
        self.guion = list(guion)
        self.intentos = 0
        self.apagados = 0
        self._cuenta = None
        self.rutas = []

    def initialize(self, path=None, timeout=None):
        self.intentos += 1
        self.rutas.append(path)
        paso = self.guion.pop(0) if self.guion else False
        self._cuenta = object() if paso is True else None
        return paso is True or paso == "sin"

    def account_info(self):
        return self._cuenta

    def last_error(self):
        return (-10005, "IPC timeout")

    def shutdown(self):
        self.apagados += 1


class Conectar(unittest.TestCase):
    def dormir(self, _s):
        self.dormidas = getattr(self, "dormidas", 0) + 1

    def test_a_la_primera_no_se_espera_nada(self):
        mt5 = FalsoMT5([True])
        self.assertEqual(conectar(mt5, dormir=self.dormir), "")
        self.assertEqual(mt5.intentos, 1)
        self.assertEqual(getattr(self, "dormidas", 0), 0)

    def test_SE_INSISTE_CUANDO_EL_TERMINAL_ESTA_OCUPADO(self):
        # Lo que paso de verdad: los primeros intentos dan IPC timeout y luego entra. Con un solo
        # intento esa pasada no ponia nada, y asi doce seguidas.
        mt5 = FalsoMT5([False, False, True])
        self.assertEqual(conectar(mt5, dormir=self.dormir), "")
        self.assertEqual(mt5.intentos, 3)
        self.assertEqual(self.dormidas, 2)

    def test_un_terminal_que_dice_que_si_pero_no_tiene_cuenta_no_vale(self):
        # Tambien es de verdad: un terminal recien arrancado contesta que si, `account_info` da
        # None y `symbols_get` una lista parcial. Con esa lista el resolutor cae al respaldo y
        # elige el simbolo del grupo caro, que ademas no se puede operar.
        mt5 = FalsoMT5(["sin", "sin", True])
        self.assertEqual(conectar(mt5, dormir=self.dormir), "")
        self.assertEqual(mt5.intentos, 3)

    def test_y_esa_conexion_a_medias_se_cierra_antes_de_reintentar(self):
        mt5 = FalsoMT5(["sin", True])
        conectar(mt5, dormir=self.dormir)
        self.assertEqual(mt5.apagados, 1)

    def test_cuando_no_entra_se_dice_cuantas_veces_se_intento(self):
        mt5 = FalsoMT5([])
        motivo = conectar(mt5, intentos=4, dormir=self.dormir)
        self.assertIn("4 intentos", motivo)
        self.assertIn("IPC timeout", motivo)
        self.assertEqual(mt5.intentos, 4)

    def test_el_mensaje_dice_QUE_terminal_se_intento_abrir(self):
        mt5 = FalsoMT5([])
        motivo = conectar(mt5, r"C:\otro\terminal64.exe", intentos=1, dormir=self.dormir)
        self.assertIn(r"C:\otro\terminal64.exe", motivo)
        self.assertEqual(mt5.rutas, [r"C:\otro\terminal64.exe"])

    def test_sin_ruta_no_se_le_pasa_ninguna(self):
        # `initialize(path="")` no es lo mismo que `initialize()`: la cadena vacia es una ruta.
        mt5 = FalsoMT5([True])
        conectar(mt5, dormir=self.dormir)
        self.assertEqual(mt5.rutas, [None])

    def test_EL_PRESUPUESTO_CABE_EN_UNA_PASADA_DE_CINCO_MINUTOS(self):
        # La cuenta que justifica los numeros por defecto. Si alguien sube los intentos o la
        # espera, esto avisa: una conexion que tarda mas que la pasada no sirve de nada.
        from terminal import ESPERA, INTENTOS, TIMEOUT_MS
        peor = INTENTOS * TIMEOUT_MS / 1000 + (INTENTOS - 1) * ESPERA
        self.assertLess(peor, 150)


if __name__ == "__main__":
    unittest.main()
