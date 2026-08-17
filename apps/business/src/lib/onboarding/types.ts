export interface CategoryOption {
  id: string;
  name: string;
}

export interface DistrictOption {
  id: string;
  name: string;
  cityId: string;
  latitude: number;
  longitude: number;
}
