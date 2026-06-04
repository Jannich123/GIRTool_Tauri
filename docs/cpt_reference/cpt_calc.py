
from math import ceil
import numpy as np
import pandas as pd
import sqlalchemy as sa
import subprocess
import pyodbc
from tqdm import tqdm
import logging
import os
import pyproj
import warnings


def CPT_Calc(CPTData, fPath, net_area_ratio, ground_water_table_elevation, Nkt_values, gamma_soil, γ_water = None, GSBLevel = dict() , Nkt_method = "Mayne and Peuchen (2022)", round_col= dict()):

    """
    Calculate various geotechnical parameters and classifications based on Cone Penetration Test (CPT) data.

    Args:
        CPTData (DataFrame): Input DataFrame containing CPT data.
        fPath (str): Path to the directory containing necessary data files.
        net_area_ratio (dict): Dictionary mapping PointNo to net area ratio values.
        ground_water_table_elevation (dict): Dictionary mapping PointNo to groundwater table elevations.
        Nkt_values (dict): Dictionary mapping Primary Layer to Nkt values.
        gamma_soil (dict): Dictionary mapping Primary Layer to unit weight values.
        γ_water (float, optional): Specific weight of water. Defaults to None.

    Returns:
        DataFrame: Modified DataFrame with calculated parameters and classifications.
    """

    pbar = tqdm(total=29)
    pbar.set_description("Calculation of CPT's")

    warnings.filterwarnings('ignore')

    current_path = os.path.dirname(os.path.abspath(__file__))
    Robertson_Qt_Fr = current_path + '\\Robertson classification_2010_Qt_Fr.csv'
    Robertson_Qt_Bq = current_path + '\\Robertson classification_2010_Qt_Bq.csv'
    #Read the csv files into a numpy array
    Robertson_Qt_Fr = pd.read_csv(Robertson_Qt_Fr).to_numpy()
    Robertson_Qt_Bq = pd.read_csv(Robertson_Qt_Bq, header = None).to_numpy()

    CPTData['PointNo'] = CPTData['PointNo'].replace('' or 'No Data', np.nan)
    CPTData.dropna(subset=['PointNo'], inplace=True)

    CPTData['Water Level'] = CPTData['PointNo'].map(ground_water_table_elevation)

    #defining some constants
    Patm = 100 #assuming Atmospheric pressure to be 100kPa
    #for γ_water if user has given value then γ_water = user given value otherwise γ_water will be assumed to be 10kN/m^3
    γ_water = 10 if γ_water is None else γ_water

    # qc (cone tip resistance); converting units from MPa to kPa
    CPTData.loc[:, 'qc'] = (CPTData['qc']*1000)

    # qc corrected for atmospheric pressure
    CPTData.loc[:, 'qc/Pa'] = (CPTData['qc']/Patm)

    # Correcting Depth according to top of seabed or ground level
    CPTData.loc[:, 'Corr_Depth'] = np.where((CPTData['Depth'] == ""), np.nan,
                                            np.where(CPTData['PointNo'].isin(list(GSBLevel.keys())),
                                                     CPTData['PointNo'].map(lambda x: GSBLevel.get(x, np.nan))-CPTData['Level'],
                                                     CPTData['Depth']))
    CPTData.loc[:, 'Corr_Depth'] = np.where((CPTData['Corr_Depth'].isna()) | (CPTData['Corr_Depth'] < 0), np.nan,CPTData['Corr_Depth'])

    #1. Calculating hydrostatic pore water pressure
    # Calculate the PWP for all rows at once using numpy's where() function: Defining a boolean mask for the rows where Level > ground_water_elevation
    CPTData.loc[:, 'u0'] = np.where(CPTData['Corr_Depth'].isna(),np.nan,np.where(CPTData['Level'] > CPTData['Water Level'], 0, (CPTData['Water Level'] - CPTData.loc[:, 'Level']) * γ_water))
    pbar.update(1)

    #2. Calculating Corrected tip resistance & FRICTION RATIO
    CPTData.loc[:,'qt']  = np.where(~CPTData['Corr_Depth'].isna(),CPTData['qc']+CPTData['u2']*(1-CPTData['PointNo'].map(net_area_ratio)),np.nan)

    condition_Rf = (CPTData['Corr_Depth'].isna()) | (CPTData['qt'] <= 0.0)
    CPTData.loc[:, 'Rf'] = np.where(condition_Rf, np.nan, CPTData['fs'] / (CPTData['qt']) * 100)
    pbar.update(1)

    #3. Calculating unit_weight γ_soil(kN/m^3) as per correlation
    #if user gives a dictionary incorporating gamma_soil to be considered as per the primary layer
    CPTData.loc[:, 'UW'] = CPTData['Primary Layer'].map(lambda x: gamma_soil.get(x, np.nan))

    #if for some particular pointNo γ (kN/m3) is not given then NaN vals of gamma would be created;which would be replaced by gamma as per the correlation
    filter_rows_for_γ_soil = ((CPTData['Corr_Depth'].isna()) | (CPTData['qt'] <= 0.0) |  (CPTData['Rf'] <= 0.0) | CPTData['qt'].isna() |  CPTData['Rf'].isna()) & CPTData['UW'].isna()
    CPTData.loc[:, 'UW'] = np.where(filter_rows_for_γ_soil, np.nan, 10 * (0.27 * np.log10(CPTData['Rf']) + 0.36 * np.log10(CPTData['qt'] / Patm) + 1.236))
    pbar.update(1)

    #4. Calculating effective_unit_weight γ'_soil(kN/m^3) as per correlation

    # Create a Dummy UW, to fill out unknown UW
    def Dum_UW(series):
        # Fill NaNs with the group mean
        filled_series = series.replace({0: pd.NA}).fillna(method='bfill').fillna(method='ffill')
        # Set the first element of the group to NaN
        filled_series.iloc[0] = np.nan
        return filled_series

    CPTData['Dum_UW'] = CPTData.groupby(['PointNo', 'TestId', 'PointId'])['UW'].transform(Dum_UW)

    mask1 = (CPTData.loc[:, 'Level'] > CPTData['Water Level'])
    mask2 = (CPTData.loc[:, 'Level'] < CPTData['Water Level']) & (CPTData.loc[:, 'Level'].shift(1) > CPTData['Water Level'])

    # Overburden pressure
    CPTData.loc[:, 'UW_eff'] = np.where(CPTData['Corr_Depth'].isna(),np.nan,
                                            np.where(mask1,(CPTData['Level'].shift(1) - CPTData['Level']) * CPTData['Dum_UW'],
                                            np.where(mask2,(CPTData['Level'].shift(1) - CPTData['Level']) * CPTData['Dum_UW'] - abs(CPTData['Water Level'] - CPTData['Level']) * γ_water,
                                                     (CPTData['Level'].shift(1) - CPTData['Level']) * (CPTData['Dum_UW'] - γ_water))))

    # Correct if first cone value is below ground level
    mask1 = (CPTData.loc[:, 'Level'] > CPTData['Water Level'])
    mask2 = (CPTData.loc[:, 'Level'] < CPTData['Water Level']) & ( (CPTData['Water Level'] - CPTData.loc[:, 'Level']) < CPTData['Corr_Depth'])

    # Overburden pressure
    CPTData.loc[:, 'UW_eff'] = np.where((CPTData['Corr_Depth'].isna()), np.nan, np.where((~CPTData['UW_eff'].isna()) | (CPTData['Corr_Depth'] == 0),CPTData['UW_eff'],
                                            np.where(mask1,CPTData['Corr_Depth'] * 20,
                                            np.where(mask2,CPTData['Corr_Depth'] * 20  - abs(CPTData['Water Level'] - CPTData['Level']) * γ_water,
                                                      CPTData['Corr_Depth'] * (20 - γ_water)))))
    CPTData['UW_eff'][CPTData['UW_eff']<0] = 0

    pbar.update(1)

    #5. Calculating effective_stress 'Sigma_eff_v0'
    CPTData['Sigma_eff_v0'] = CPTData.groupby(['PointNo', 'TestId', 'PointId'])['UW_eff'].transform('cumsum')
    pbar.update(1)

    #6. Calculating total_stress 'Sigma_t_v0'
    CPTData.loc[:, 'Sigma_t_v0'] = CPTData.loc[:, 'Sigma_eff_v0'] + CPTData.loc[:, 'u0']
    pbar.update(1)

    #7. Stress Ratio; "Stress_Ratio =  σt_v0/σ'v0"
    CPTData.loc[:, 'Stress_Ratio'] = np.where(CPTData['Corr_Depth'].isna(),np.nan,np.where(CPTData['Sigma_eff_v0'] ==  0, np.nan, (CPTData['Sigma_t_v0']/CPTData['Sigma_eff_v0'])))
    pbar.update(1)

    #8. Normalized SBT (n = 1) Qt & Fr (%)
    CPTData.loc[:, 'Qt_n'] = np.where(CPTData['Corr_Depth'].isna() |  CPTData['Sigma_eff_v0'].isna() |  CPTData['Sigma_eff_v0'] <= 0, np.nan, (CPTData['qt'] - CPTData['Sigma_t_v0'])/CPTData['Sigma_eff_v0'])
    CPTData['Qt_n'][CPTData['Qt_n']<0] = 0
    CPTData.loc[:, 'Fr'] = np.where(CPTData['Corr_Depth'].isna() |  CPTData['Sigma_eff_v0'].isna() |  CPTData['Sigma_eff_v0'] <= 0, np.nan, (CPTData['fs']/(CPTData['qt']-CPTData['Sigma_t_v0'])*100))
    pbar.update(1)

    #9. Bq parameters
    CPTData.loc[:, 'Delta_u'] = np.where(CPTData['Corr_Depth'].isna(), np.nan, CPTData['u2'] - CPTData['u0'])
    CPTData.loc[:, 'qn'] = np.where(CPTData['Corr_Depth'].isna(), np.nan, CPTData['qt'] - CPTData['Sigma_t_v0'])
    CPTData.loc[:, 'Bq'] = np.where(CPTData['Corr_Depth'].isna() , np.nan, CPTData['Delta_u']/CPTData['qn'])
    pbar.update(1)

    #10. Nkt for undrained shear strength (Su)
    CPTData['Nkt'] = CPTData['Primary Layer'].map(lambda x: Nkt_values.get(x, np.nan))  #taking the values of Nkt based on primary layer from the defined dictionary
    filter_rows_for_Nkt = (CPTData['Corr_Depth'].isna()) | (CPTData['Fr'] == 0.0) | CPTData['Fr'].isna()
    # Either calculate according to Robertson (2012) or Mayne and Peuchen (2022):
    if Nkt_method == "Robertson (2012)":
        CPTData.loc[:, 'Nkt'] = np.where(~CPTData['Nkt'].isna(),CPTData['Nkt'], np.where(filter_rows_for_Nkt, np.nan, 10.5 + 7 * np.log10(CPTData['Fr'])))
    elif Nkt_method == "Mayne and Peuchen (2022)":
        CPTData.loc[:, 'Nkt'] = np.where(~CPTData['Nkt'].isna(),CPTData['Nkt'], np.where(filter_rows_for_Nkt, np.nan, 10.5 - (4.6 * np.log(CPTData['Bq'] + 0.1))))
    pbar.update(1)

    #11. Su based on qt and Nkt
    filter_rows_for_Su = (CPTData['Corr_Depth'].isna()) | CPTData['Nkt'].isna() | CPTData['Nkt'] == 0
    CPTData.loc[:, 'su_qt'] =  np.where(filter_rows_for_Su, np.nan, (CPTData['qt'] - CPTData['Sigma_t_v0'])/CPTData["Nkt"])
    pbar.update(1)

    #12. Su based on Δu
    CPTData.loc[:, 'N_Delta_u'] = np.where(CPTData['Corr_Depth'].isna(), np.nan, CPTData['Nkt']*CPTData['Bq'])
    CPTData.loc[:, 'Su_Delta_u'] = np.where(CPTData['Corr_Depth'].isna() ,np.nan, CPTData['Delta_u']/CPTData['N_Delta_u'])
    pbar.update(1)

    #13. Normalized SBTn parameters; n, Cn, Qtn, Ic
    # writing a custom function for calculating the value of Normalized SBTn parameters
    def normalized_SBT_parameters(qt, sigma_eff, sigma_t, Fr_normalized):
        if  (qt > 0) and (Fr_normalized > 0) and (sigma_eff > 0) and (sigma_t > 0):
            n = 1 #initalizing the value of n = 1 (reference CPT Guide by Robertson's Book)
            Qtn = (qt - sigma_t)/sigma_eff ; term1 = (3.47-np.log10(Qtn))**2 ; term2 = (1.22+np.log10(Fr_normalized))**2
            Ic = (term1+term2)**0.5
            Ic_new = Ic; Ic_old = 0
            i = 0
            while True:
                n = min(1, 0.381 * Ic_new + 0.05*(sigma_eff/Patm) - 0.15)
                Cn = (Patm/sigma_eff)**n ; Qtn =((qt- sigma_t)/Patm) * Cn
                term1 = (3.47-np.log10(Qtn))**2; term2 = (1.22+np.log10(Fr_normalized))**2 ; Ic_old = Ic_new
                Ic_new = (term1+term2)**0.5; i += 1
                if abs(Ic_new - Ic_old) / Ic_old < 0.01 or i == 100:
                    break
            return n, Cn, Qtn, Ic_new
        else:
            return np.nan, np.nan, np.nan, np.nan

    #Applying the customized function on the dataframe
    cols = ['qt', 'Sigma_eff_v0', 'Sigma_t_v0', 'Fr']
    mask =  (~CPTData['Fr'].isna()) & (CPTData['qt'] > 0 ) & (CPTData['Sigma_eff_v0'] > 0.0) &  (CPTData['Sigma_t_v0'] > 0.0) & (CPTData['Fr'] > 0.0) & (~CPTData['Corr_Depth'].isna())
    CPTData[['n', 'Cn', 'Qtn', 'Ic']] = CPTData.loc[mask, cols].apply(lambda x: normalized_SBT_parameters(x['qt'], x['Sigma_eff_v0'], x['Sigma_t_v0'], x['Fr']), axis=1, result_type='expand')
    pbar.update(1)

    #14. Robertson'classification according to Robertson (2010)
    #Defining a soil_class dictionary with zones as key and Soil class as value
    soil_class = {
        1: 'Sensitive, fine grained',
        2: 'Organic soils - clay',
        3: 'Clay - silty clay to clay',
        4: 'Silt mixtures - clayey silt to silty clay',
        5: 'Sand mixtures - silty sand to sandy silt',
        6: 'Sands - clean sand to silty sand',
        7: 'Gravelly sand to dense sand',
        8: 'Very stiff sand to clayey sand',
        9: 'Very stiff fine grained'
    }
  #function for soil classification as per Robertson's classification Qt-Fr, 2010
    def Robertson_Qt_Fr_2010(Depth, Qtn, Fr):
        if Depth and isinstance(Depth, (int, float)) and Depth != 0 and isinstance(Fr, (int, float)) and Fr > 0 and isinstance(Qtn, (int, float)) and Qtn > 0:
            values_Qtn_vertical = Robertson_Qt_Fr[2:153,2].astype(float)
            values_Fr_horizontal = Robertson_Qt_Fr[1][3:104].astype(float)
            ligne = np.searchsorted(values_Qtn_vertical, -np.log10(Qtn), side='right')
            colonne = np.searchsorted(values_Fr_horizontal, np.log10(Fr), side='right')
            if 0 < ligne < len(values_Qtn_vertical) and 0 < colonne < len(values_Fr_horizontal):
                zone = int(Robertson_Qt_Fr[2:-1,3:-1][ligne-1][colonne-1])
                soil_type = soil_class.get(zone," ")
                return ligne, colonne, zone, soil_type
        return np.nan, np.nan, np.nan, np.nan
    #Applying the function on the dataframe
    CPTData[['Ligne', 'Colonne', 'Zone', 'SBTn']] = CPTData.apply(lambda x: Robertson_Qt_Fr_2010(x['Depth'], x['Qtn'], x['Fr']), axis=1, result_type='expand')
    #changing the datatype of zone column from float to integer
    CPTData['Colonne'] = CPTData['Colonne'].replace({0: pd.NA}).fillna(0).astype(int)
    CPTData['Zone'] = CPTData['Zone'].replace({0: pd.NA}).fillna(0).astype(int)

    #function for soil classification as per Robertson's classification Qt-Bq, 2010
    def Robertson_Qt_Bq_2010(Depth, Qtn, Bq):
        if Depth and isinstance(Depth, (int, float)) and Depth != 0 and isinstance(Qtn, (int, float)) and Qtn > 0:
            values_Qtn_vertical = Robertson_Qt_Bq[2:153,1]
            values_Bq_horizontal = Robertson_Qt_Bq[0][3:104]
            ligne = np.searchsorted(values_Qtn_vertical, -np.log10(Qtn), side='left')
            colonne = np.searchsorted(values_Bq_horizontal, Bq, side='left')
            if 0 < ligne < len(values_Qtn_vertical) and 0 < colonne < len(values_Bq_horizontal):
                zone = int(Robertson_Qt_Bq[2:-1,3:-1][ligne-1][colonne-1])
                soil_type = soil_class.get(zone, "")
                return ligne, colonne, zone, soil_type
        return np.nan, np.nan, np.nan, np.nan
   #applying the function on the dataframe
    CPTData[['Ligne_2', 'Colonne_2', 'Zone_2', 'Type_2']] = CPTData.apply(lambda x: Robertson_Qt_Bq_2010(x['Depth'], x['Qtn'], x["Bq"]), axis=1, result_type='expand')
    CPTData['Colonne_2'] = CPTData['Colonne_2'].replace({0: pd.NA}).fillna(0).astype(int)
    CPTData['Zone_2'] = CPTData['Zone_2'].replace({0: pd.NA}).fillna(0).astype(int)
    pbar.update(1)

    #15. Sensitivity in clays and silts.....add script to handle 0 denominator values
    CPTData.loc[:, 'su(Rem)'] = np.where(CPTData['Corr_Depth'].isna(),np.nan,CPTData['fs'])
    CPTData.loc[:, 'St'] = np.where((~CPTData['Corr_Depth'].isna()) & (CPTData['Ic'] < 2.6) & (CPTData['su(Rem)'] != 0.0) ,CPTData['su_qt']/CPTData['su(Rem)'], np.nan)
    CPTData['su_Ratio'] = np.where(CPTData['Nkt'] != 0, np.where((CPTData['Corr_Depth'].isna()) | (CPTData['Ic'] > 2.6), CPTData['Sigma_eff_v0']*CPTData['Qt_n']/CPTData['Nkt'], np.nan), np.nan)
    CPTData['su(Rem)_Ratio'] = np.where((~CPTData['Corr_Depth'].isna()) | (CPTData['Ic'] < 2.6), CPTData['su(Rem)']/CPTData['Sigma_eff_v0'], np.nan)
    pbar.update(1)

    #16.OCR based on Robertson, 2013
    CPTData.loc[:, 'OCR_2013'] = np.where(CPTData['Corr_Depth'].isna() |  CPTData['Sigma_eff_v0'].isna() |  (CPTData['Sigma_eff_v0'] == 0) | (CPTData['qt'] >= 20),
                                          np.nan,
                                          (2.625 + 1.75*np.log10(CPTData['Fr']))**(-1.25)*(CPTData['Qt_n']**1.25))
    pbar.update(1)

    #17.OCR based on Robertson, 2009
    CPTData.loc[:, 'OCR_2009'] = np.where(CPTData['Corr_Depth'].isna() |  CPTData['Sigma_eff_v0'].isna() |  (CPTData['Sigma_eff_v0'] == 0) | (CPTData['St'] < 15),
                                          np.nan,
                                          0.25*(CPTData['Qt_n']**1.25))
    pbar.update(1)

    #18.OCR based on Mayne, 1992
    CPTData.loc[:, 'm'] = np.where((CPTData['Corr_Depth'].isna()) ,np.nan,np.where(CPTData['Ic']>2.8, 1.0, (1-0.28/(1+(CPTData['Ic']/2.65)**15))))
    CPTData.loc[:, 'sigma_eff_p'] = np.where((CPTData['Corr_Depth'].isna()) ,np.nan, 0.33*(CPTData['qt']-CPTData['Sigma_t_v0'])**CPTData['m']*(Patm/100)**(1-CPTData['m']))
    CPTData.loc[:, 'OCR_1992'] = np.where((CPTData['Corr_Depth'].isna()) | (CPTData['Sigma_eff_v0'] == 0) ,np.nan, CPTData['sigma_eff_p']/CPTData['Sigma_eff_v0'])
    pbar.update(1)

    #19. Drained Young's modulus in sands
    CPTData.loc[:, 'alpha_E'] = np.where (~CPTData['Corr_Depth'].isna(), np.where((CPTData['Ic'] < 2.6), 0.015*10**(0.55*CPTData['Ic']+1.68), np.nan), np.nan)
    CPTData.loc[:, 'Es'] = np.where ((~CPTData['Corr_Depth'].isna()), np.where((CPTData['Ic'] < 2.6), CPTData['alpha_E']*(CPTData['qt']-CPTData['Sigma_t_v0'])/1000, np.nan), np.nan)
    pbar.update(1)

    #20.1D constrained modulus (MPa)
    CPTData.loc[:, 'alpha_M'] = np.where(~CPTData['Corr_Depth'].isna(), np.where((CPTData['Ic']<=2.2), (0.0188*10**(0.55*CPTData['Ic']+1.68)).clip(upper=8), np.where((CPTData['Qt_n'] <= 8), CPTData['Qt_n'], 8)),  np.nan)
    CPTData.loc[:, 'Ms'] = np.where(~CPTData['Corr_Depth'].isna(),CPTData['alpha_M']*(CPTData['qt']-CPTData['Sigma_t_v0'])/1000, np.nan)
    CPTData.loc[:, 'Ms/qc'] = np.where(~CPTData['Corr_Depth'].isna(),CPTData['Ms']/(CPTData['qc']/1000), np.nan)
    pbar.update(1)

    #21. Relative Density as per Baldi, 1986
    CPTData.loc[:, 'Dr (Baldi, 1986)'] = np.where(~CPTData['Corr_Depth'].isna(),np.where(CPTData['Ic'] < 1.6,  (1/2.41)*np.log(CPTData['Qtn']/15.7), np.nan), np.nan)
    CPTData.loc[:, 'Dr (Kulhawy & Mayne, 1990)'] = np.where(~CPTData['Corr_Depth'].isna(),np.where(CPTData['Ic'] < 1.6, ((CPTData['Qtn']/350)**0.5), np.nan), np.nan)
    CPTData.loc[:, 'Dr (Bray and Olaya, 2022)'] = np.where(~CPTData['Corr_Depth'].isna(),
                                                           np.where(CPTData['Ic'] < 1.6,
                                                                    ((CPTData['Qtn']/350)**0.5),
                                                                    np.where(CPTData['Ic'] <= 2.6,
                                                                             (((CPTData['Qtn']*CPTData['Ic']**3.5)/1500)**0.5),
                                                                             np.nan)),
                                                           np.nan)
    pbar.update(1)

    #22. State Parameters
    # Robertson (2022) suggested correction factor
    CPTData.loc[:, 'K_c'] = np.where((~CPTData['Corr_Depth'].isna()) & (CPTData['Ic'] <= 3.),
                                     np.where(CPTData['Ic'] <= 1.7,1,
                                              15-(14/(1+(CPTData['Ic']/2.95)**11))), np.nan)
    # clean sand equivalent normalized cone resistance
    CPTData.loc[:, 'Qtn,cs'] = np.where(~CPTData['Corr_Depth'].isna(), np.where(CPTData['Ic'] >= 2.7, np.nan, CPTData['K_c']*CPTData['Qtn']),np.nan)
    # state parameter
    CPTData.loc[:, 'Psi'] = np.where(CPTData['Corr_Depth'].isna(), np.nan, np.where(CPTData['Ic'] >= 2.7, np.nan, 0.56-0.33*np.log10(CPTData['Qtn,cs'])))
    pbar.update(1)

    #23. Peak friction angle in sands φ' (°)
    #a. Roberston & Campanella
    CPTData.loc[:, 'Phi_Rob_Cam'] = np.where((CPTData['Corr_Depth'].isna()) | (CPTData['Sigma_eff_v0'] == 0) | (CPTData['qc'] == 0) ,np.nan,
                                                        np.where(CPTData['Ic'] < 2.6,  np.arctan((1 / 2.68) * (np.log10(CPTData['qc']/CPTData['Sigma_eff_v0']) + 0.29)) * (180 / np.pi),np.nan))
    #b.Kulhawy & Mayne
    CPTData.loc[:, 'Phi_Kul_May'] = np.where((CPTData['Corr_Depth'].isna()) | (CPTData['Qtn'] == 0) ,np.nan, np.where(CPTData['Ic'] < 2.6,  17.6+11*np.log10(CPTData['Qtn']),np.nan))
    #c.Jefferies & Been
    CPTData.loc[:, 'Phi_Jeff_Been'] = np.where((CPTData['Corr_Depth'].isna()) | (CPTData['Qtn,cs'] == 0), np.nan, np.where(CPTData['Ic'] < 2.6, 3+15.84*np.log10(CPTData['Qtn,cs'])-26.88,np.nan))
    pbar.update(1)


    #24.Peak friction angle in clays/silts φ' (°) and In-Situ Stress Ratio (Ko)
    CPTData.loc[:, 'Phi_Mayne_2006'] = np.where(~CPTData['Corr_Depth'].isna(),
                      np.where(np.logical_and(CPTData['Ic'] >= 2.6, CPTData['Bq'] > 0.1),
                        29.5 * CPTData['Bq']**0.121 * (0.256 + 0.336 * CPTData['Bq'] + np.log10(CPTData['Qt_n'])),np.nan),np.nan)
    for item in ['OCR_2013','OCR_2009','OCR_1992']:
        CPTData.loc[:, 'K_0_' + item] = np.where(~CPTData['Corr_Depth'].isna(),
                                         (1-np.sin(CPTData['Phi_Mayne_2006']* np.pi / 180))*CPTData[item]**np.sin(CPTData['Phi_Mayne_2006']* np.pi / 180),
                                         np.nan)
    pbar.update(1)

    #25. Shear Wave Velocity
    CPTData.loc[:, 'alpha_vs'] = np.where(CPTData['Corr_Depth'].isna(),np.nan, 10**(0.55*CPTData['Ic']+1.68))
    CPTData.loc[:, 'Vs'] = np.where(CPTData['Corr_Depth'].isna(), np.nan, (CPTData['alpha_vs']*(CPTData['qt']-CPTData['Sigma_t_v0'])/100)**0.5)
    CPTData.loc[:, 'Vs1'] = np.where(CPTData['Corr_Depth'].isna(), np.nan, CPTData['Vs']*(100/CPTData['Sigma_eff_v0'])**0.25)
    pbar.update(1)

    #26. Small strain shear modulus
    CPTData.loc[:, 'G_0'] = np.where(CPTData['Corr_Depth'].isna(),np.nan, CPTData['UW']/ γ_water * CPTData['Vs']**2 / 1000)
    CPTData.loc[:, 'K_G']  = np.where(CPTData['Corr_Depth'].isna(),np.nan, (CPTData['G_0']*1000/(CPTData['qt']-CPTData['Sigma_t_v0']))*CPTData['Qtn']**0.75)
    pbar.update(1)

    #27. Hydraulic Conductivity
    CPTData.loc[:, 'k'] = np.where(~CPTData['Corr_Depth'].isna(),np.where(np.logical_and(CPTData['Ic'] > 1, CPTData['Ic'] <= 3.27),10**(0.952 - 3.04 * CPTData['Ic']),
                               np.where(np.logical_and(CPTData['Ic'] > 3.27, CPTData['Ic']< 4),10**(-4.52 - 1.37 * CPTData['Ic']),np.nan)),np.nan)
    pbar.update(1)

    #28. N60 SPT equivalent Robertson (2012)
    CPTData.loc[:, 'N60'] = np.where(~CPTData['Corr_Depth'].isna(),(CPTData['qt']/101.325)/(10**(1.1268-0.2817*CPTData['Ic'])),np.nan)
    pbar.update(1)


    #29. Outside Graph ? 0 = No, 1 = Yes
    CPTData.loc[:, 'Robertson 2010'] = np.where(~CPTData['Corr_Depth'].isna(),np.where(np.isnan(CPTData['Qtn']), 0,
                               np.where(np.logical_and(np.logical_and(CPTData['Fr'] >= 0.1, CPTData['Fr'] <= 10),
                                                       np.logical_and(CPTData['Qtn'] >= 1, CPTData['Qtn'] <= 1000)), 0, 1)),np.nan)

    CPTData.loc[:, 'Robertson 1986'] = np.where(~CPTData['Corr_Depth'].isna(),
                          np.where(np.logical_and(np.logical_and(CPTData['Rf'] >= 0, CPTData['Rf']  <= 8), np.logical_and(CPTData['qc'] >= 0.1, CPTData['qc'] <= 100)), 0, 1),
                          np.nan)

    CPTData.loc[:, 'Schmertmann 1978'] = np.where(~CPTData['Corr_Depth'].isna(),
                  np.where(np.logical_and(np.logical_and(CPTData['Rf'] >= 0, CPTData['Rf'] <= 7), np.logical_and(CPTData['qc'] >= 0.1, CPTData['qc'] <= 100)), 0, 1),np.nan)
    pbar.update(1)

    # qc (cone tip resistance), fs (sleeve friction/restsiance) and u2 (porepressure) convert back to MPa
    CPTData.loc[:, 'qc'] = (CPTData['qc']/1000)
    CPTData.loc[:, 'qt'] = (CPTData['qt']/1000)

    if bool(round_col):
        for key in round_col.keys():
            CPTData[key] = np.where(CPTData[key].isna(),np.nan, np.round(CPTData[key], round_col[key]))

    pbar.close()

    return CPTData.replace([np.nan, -np.inf,np.inf], '')
