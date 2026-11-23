import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location('extract_model', Path(__file__).with_name('extract-model.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class ModelArchiveTests(unittest.TestCase):
    def make_archive(self, package, files):
        with tarfile.open(package, 'w:bz2') as archive:
            for path in files:
                info = tarfile.TarInfo(f'{extractor.MODEL}/{path}')
                content = path.encode()
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))

    def test_extracts_only_the_four_regular_files(self):
        with tempfile.TemporaryDirectory() as path:
            source, dest = Path(path) / 'model.tar.bz2', Path(path) / 'out'
            self.make_archive(source, ['notes.txt', *sorted(extractor.FILES)])
            extractor.extract_model(source, dest)
            self.assertEqual({p.name: p.read_text() for p in dest.iterdir()}, {f: f for f in extractor.FILES})

    def test_incomplete_archive_is_an_error(self):
        with tempfile.TemporaryDirectory() as path:
            source, dest = Path(path) / 'model.tar.bz2', Path(path) / 'out'
            self.make_archive(source, ['tokens.txt'])
            with self.assertRaises(ValueError):
                extractor.extract_model(source, dest)


if __name__ == '__main__':
    unittest.main()
